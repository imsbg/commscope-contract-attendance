const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

// Your EXACT working Google Apps Script URL
const GAS_URL = "https://script.google.com/macros/s/AKfycbzBMx-fZAifindtXbsXVueYEYQz4uBT1cA8CnlrZH3MTHEyR4RMv6uxaPhdKwskiP4T/exec";
 
async function fetchAndParsePDF() {
    console.log("🌐 Fetching PDF from Google Apps Script...");
    
    const response = await fetch(GAS_URL);
    if (!response.ok) throw new Error("Network response was not ok");
    
    const json = await response.json();
    if (!json.success) throw new Error("GAS Error: " + json.error);
    
    console.log("📦 Decoding Base64 PDF data...");
    const pdfBuffer = Buffer.from(json.data, 'base64');
    const pdfData = new Uint8Array(pdfBuffer);
    
    console.log("⚙️ Parsing PDF with pdf.js...");
    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    
    let globalData = [];
    let currentMonthStr = "Unknown Month";

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        // 1. Extract all text items
        let items = textContent.items
            .map(item => ({ text: item.str.trim(), x: item.transform[4], y: item.transform[5] }))
            .filter(item => item.text !== '');

        // 2. BULLETPROOF BUCKET GROUPING (Prevents rows from cascading into each other)
        let rowMap = new Map();
        const Y_TOLERANCE = 4; // Safely snaps items within a strict 4-point vertical band

        for (let item of items) {
            let placed = false;
            
            // Look for an existing row bucket this item belongs to
            for (let [baseY, rowItems] of rowMap.entries()) {
                if (Math.abs(baseY - item.y) <= Y_TOLERANCE) {
                    rowItems.push(item);
                    placed = true;
                    break;
                }
            }
            
            // If it doesn't fit in any existing row, create a new row bucket
            if (!placed) {
                rowMap.set(item.y, [item]);
            }
        }

        // 3. Sort the row buckets from Top of page to Bottom
        let sortedYKeys = Array.from(rowMap.keys()).sort((a, b) => b - a);
        let lines = sortedYKeys.map(y => rowMap.get(y));

        // 4. Process each row line into employee data
        for (let line of lines) {
            // Sort line items strictly left-to-right
            line.sort((a, b) => a.x - b.x);

            // Anti-duplication filter (Fixes the "Active Active" bug in some PDFs)
            let uniqueLine = [];
            for (let item of line) {
                let isDuplicate = uniqueLine.some(u => u.text === item.text && Math.abs(u.x - item.x) < 12);
                if (!isDuplicate) {
                    uniqueLine.push(item);
                }
            }

            let sortedItems = uniqueLine.map(u => u.text);
            const rowText = sortedItems.join(" ");

            // Grab Month Header
            if (currentMonthStr === "Unknown Month" && rowText.toLowerCase().includes("attendance for the month of")) {
                const match = rowText.match(/Attendance for the Month of\s*([A-Za-z]+\s*\d{4})/i);
                if (match) currentMonthStr = match[1];
            }

            // Re-merge HO and (ROTA) if they were split by spacing
            for (let j = 0; j < sortedItems.length - 1; j++) {
                if (sortedItems[j] === 'HO' && sortedItems[j+1] === '(ROTA)') {
                    sortedItems[j] = 'HO (ROTA)';
                    sortedItems.splice(j+1, 1);
                }
            }

            let statusIdx = sortedItems.findIndex(str => str.toLowerCase() === 'active' || str.toLowerCase() === 'left');
            
            // Check if it's a valid employee row (Status found, long enough, not header)
            if (statusIdx >= 1 && sortedItems.length >= 6 && !sortedItems[0].toLowerCase().includes("employee")) {
                
                let code = sortedItems[0];
                let name = sortedItems.slice(1, statusIdx).join(' ');
                let status = sortedItems[statusIdx];
                
                const attCodes = new Set(['p', 'a', 'wo', 'hd', 'fd', 'slwp', 'mp', 'l', '-', '--', 'ho', 'rota', 'ho (rota)']);
                
                let firstDateIdx = -1;
                for(let j = statusIdx + 1; j < sortedItems.length; j++) {
                    if (attCodes.has(sortedItems[j].toLowerCase())) {
                        firstDateIdx = j;
                        break;
                    }
                }

                if (firstDateIdx !== -1) {
                    let contractor = sortedItems.slice(statusIdx + 1, firstDateIdx).join(' ');
                    
                    let lastDateIdx = firstDateIdx;
                    while (lastDateIdx < sortedItems.length && attCodes.has(sortedItems[lastDateIdx].toLowerCase())) {
                        lastDateIdx++;
                    }
                    lastDateIdx--;

                    let datesArray = sortedItems.slice(firstDateIdx, lastDateIdx + 1);
                    while (datesArray.length < 31) datesArray.push('-');

                    let remainingWords = sortedItems.slice(lastDateIdx + 1);
                    let tl = "N/A";
                    let sanctioner = "N/A";
                    
                    if (remainingWords.length >= 2) {
                        if (remainingWords.length === 2) {
                            tl = remainingWords[0];
                            sanctioner = remainingWords[1];
                        } else {
                            let half = Math.floor(remainingWords.length / 2);
                            tl = remainingWords.slice(0, half).join(' ');
                            sanctioner = remainingWords.slice(half).join(' ');
                        }
                    } else if (remainingWords.length === 1) {
                        tl = remainingWords[0];
                    }

                    // Only push clean rows to prevent UI crashing
                    if (code.length > 2 && name.length > 2) {
                        globalData.push({ code, name, status, contractor, dates: datesArray, tl, sanctioner });
                    }
                }
            }
        }
    }

    console.log(`✅ Successfully parsed ${globalData.length} employee records.`);
    fs.writeFileSync('data.json', JSON.stringify({ currentMonthStr, globalData }));
    console.log("🚀 Saved to data.json successfully!");
}

fetchAndParsePDF().catch(err => {
    console.error("❌ Fatal Error:", err.message);
    process.exit(1);
});
