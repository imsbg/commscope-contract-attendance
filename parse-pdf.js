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
        
        const rows = {};
        
        // Group items by Y coordinate (row)
        textContent.items.forEach(item => {
            const text = item.str.trim();
            if (!text) return;
            
            const y = item.transform[5];
            const x = item.transform[4];
            
            let rowY = Object.keys(rows).find(key => Math.abs(key - y) <= 4);
            if (!rowY) {
                rowY = y;
                rows[rowY] = [];
            }
            
            // FIX 1: ANTI-DUPLICATION
            // If the same exact text exists at almost the exact same X coordinate, ignore it.
            // This prevents "Active Active" and "ADECCO ADECCO" from fake-bolding in the PDF.
            const isDuplicate = rows[rowY].some(existing => 
                existing.text === text && Math.abs(existing.x - x) < 5
            );
            
            if (!isDuplicate) {
                rows[rowY].push({ text: text, x: x });
            }
        });
        
        Object.values(rows).forEach(rowItems => {
            // Sort left-to-right to recreate the exact table row
            let sortedItems = rowItems.sort((a, b) => a.x - b.x).map(item => item.text);
            const rowText = sortedItems.join(" ");
            
            // Extract Month Header
            if (currentMonthStr === "Unknown Month" && rowText.toLowerCase().includes("attendance for the month of")) {
                const match = rowText.match(/Attendance for the Month of\s*([A-Za-z]+\s*\d{4})/i);
                if (match) currentMonthStr = match[1];
            }
            
            // FIX 2: Combine 'HO' and '(ROTA)' if PDF.js split them apart
            for (let j = 0; j < sortedItems.length - 1; j++) {
                if (sortedItems[j] === 'HO' && sortedItems[j+1] === '(ROTA)') {
                    sortedItems[j] = 'HO (ROTA)';
                    sortedItems.splice(j+1, 1);
                }
            }
            
            let statusIdx = sortedItems.findIndex(str => str.toLowerCase() === 'active' || str.toLowerCase() === 'left');
            
            if (statusIdx !== -1 && sortedItems.length >= 6 && !sortedItems[0].toLowerCase().includes("employee")) {
                
                let code = sortedItems[0];
                let name = sortedItems.slice(1, statusIdx).join(' ');
                let status = sortedItems[statusIdx];
                
                // FIX 3: Dynamic Date Boundary
                // Find exactly where the dates start, so Contractor name lengths don't break the array
                const attendanceMarks = ['p', 'a', 'wo', 'hd', 'fd', 'slwp', 'mp', 'l', '-', '--', 'ho', 'rota', 'ho (rota)'];
                let firstDateIdx = -1;
                
                for (let j = statusIdx + 1; j < sortedItems.length; j++) {
                    if (attendanceMarks.includes(sortedItems[j].toLowerCase())) {
                        firstDateIdx = j;
                        break;
                    }
                }
                
                if (firstDateIdx === -1) firstDateIdx = statusIdx + 2; 
                let contractor = sortedItems.slice(statusIdx + 1, firstDateIdx).join(' ');
                
                // Find exactly where the dates end
                let lastDateIdx = firstDateIdx - 1;
                while (lastDateIdx + 1 < sortedItems.length && 
                      attendanceMarks.includes(sortedItems[lastDateIdx + 1].toLowerCase())) {
                    lastDateIdx++;
                }
                
                let datesArray = sortedItems.slice(firstDateIdx, lastDateIdx + 1);
                
                // Pad to 31 days
                while (datesArray.length < 31) datesArray.push('-');

                // FIX 4: Handle multiple words for TL and Sanctioner accurately
                let remainingWords = sortedItems.slice(lastDateIdx + 1);
                let tl = "N/A";
                let sanctioner = "N/A";
                
                if (remainingWords.length >= 2) {
                    if (remainingWords.length === 2) {
                        tl = remainingWords[0];
                        sanctioner = remainingWords[1];
                    } else {
                        // Split remaining words in half for TL and Sanctioner
                        let half = Math.floor(remainingWords.length / 2);
                        tl = remainingWords.slice(0, half).join(' ');
                        sanctioner = remainingWords.slice(half).join(' ');
                    }
                } else if (remainingWords.length === 1) {
                    tl = remainingWords[0];
                }

                globalData.push({ code, name, status, contractor, dates: datesArray, tl, sanctioner });
            }
        });
    }

    console.log(`✅ Successfully parsed ${globalData.length} employee records.`);
    
    // Save to data.json
    fs.writeFileSync('data.json', JSON.stringify({ currentMonthStr, globalData }));
    console.log("🚀 Saved to data.json successfully!");
}

fetchAndParsePDF().catch(err => {
    console.error("❌ Fatal Error:", err.message);
    process.exit(1);
});
