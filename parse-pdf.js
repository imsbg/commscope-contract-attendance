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
        
        let items = textContent.items
            .map(item => ({ text: item.str.trim(), x: item.transform[4], y: item.transform[5] }))
            .filter(item => item.text !== '');

        // 1. EXTRACT MONTH (Safe extraction from full page text)
        let fullPageText = items.map(i => i.text).join(' ');
        const monthMatch = fullPageText.match(/Attendance for the Month of\s*([A-Za-z]+\s*\d{4})/i);
        if (monthMatch && currentMonthStr === "Unknown Month") {
            currentMonthStr = monthMatch[1];
        }

        // 2. STABLE 2D SORT
        items.sort((a, b) => {
            if (Math.abs(b.y - a.y) > 3) return b.y - a.y; 
            return a.x - b.x; 
        });

        // 3. ANCHOR GROUPING (Splits rows exactly on Employee Code, drops Headers/Footers)
        let lines = [];
        let currentRow = [];

        for (let item of items) {
            let t = item.text.toLowerCase();
            
            // Instantly destroy known footer garbage
            if (t === 'page' || t === 'of') continue;
            
            const isEmployeeCode = /^[A-Z0-9]{2,6}-\d{3,8}$/i.test(item.text) && item.x < 150;

            if (isEmployeeCode) {
                if (currentRow.length > 0) lines.push(currentRow);
                currentRow = [item];
            } else {
                // Only push data if we are actively inside an employee row (Drops Page Headers)
                if (currentRow.length > 0) {
                    // Ignore solitary large numbers (like Page 38)
                    if (/^\d+$/.test(item.text) && parseInt(item.text) > 31) continue; 
                    currentRow.push(item);
                }
            }
        }
        if (currentRow.length > 0) lines.push(currentRow);

        // 4. PROCESS EACH ROW
        for (let line of lines) {
            line.sort((a, b) => a.x - b.x);

            // Anti-duplication filter
            let uniqueLine = [];
            for (let item of line) {
                let isDuplicate = uniqueLine.some(u => u.text === item.text && Math.abs(u.x - item.x) < 12);
                if (!isDuplicate) uniqueLine.push(item);
            }

            let sortedItems = uniqueLine.map(u => u.text);

            // PRE-CLEANUP: Remove "(Pending)" from SLWP to prevent it bleeding into Contractor
            for (let j = 0; j < sortedItems.length; j++) {
                sortedItems[j] = sortedItems[j].replace(/\s*\(Pending\)/ig, '').trim();
                
                // Re-merge HO (ROTA)
                if (sortedItems[j] === 'HO' && sortedItems[j+1] === '(ROTA)') {
                    sortedItems[j] = 'HO (ROTA)';
                    sortedItems.splice(j+1, 1);
                    j--;
                }
            }

            let statusIdx = sortedItems.findIndex(str => str.toLowerCase() === 'active' || str.toLowerCase() === 'left');
            
            if (statusIdx >= 1 && sortedItems.length >= 6) {
                let code = sortedItems[0];
                let name = sortedItems.slice(1, statusIdx).join(' ');
                let status = sortedItems[statusIdx];
                
                // PRE-CLEANUP: Remove duplicate Statuses (e.g. 'Left SHAM' fix)
                for(let j = statusIdx + 1; j < sortedItems.length; j++) {
                    let t = sortedItems[j].toLowerCase();
                    if (t === 'active' || t === 'left') {
                        sortedItems.splice(j, 1);
                        j--; 
                    }
                }
                
                // Extended attendance codes including LWP
                const attCodes = new Set(['p', 'a', 'wo', 'hd', 'fd', 'slwp', 'lwp', 'mp', 'l', '-', '--', 'ho', 'rota', 'ho (rota)']);
                
                let firstDateIdx = -1;
                for(let j = statusIdx + 1; j < sortedItems.length; j++) {
                    if (attCodes.has(sortedItems[j].toLowerCase())) {
                        firstDateIdx = j;
                        break;
                    }
                }

                if (firstDateIdx !== -1) {
                    let rawContractor = sortedItems.slice(statusIdx + 1, firstDateIdx).join(' ');
                    
                    // ⭐ SMART SANITIZER: Forces perfect Contractor Names ⭐
                    let contractor = rawContractor;
                    let cLower = rawContractor.toLowerCase();
                    
                    if (cLower.includes('adecco')) contractor = 'ADECCO';
                    else if (cLower.includes('ananya')) contractor = 'ANANYA';
                    else if (cLower.includes('dibya')) contractor = 'Dibya Industrial Service';
                    else if (cLower.includes('esjay')) contractor = 'ESJAY';
                    else if (cLower.includes('mathew')) contractor = 'MATHEW';
                    else if (cLower.includes('om sai')) contractor = 'Om Sai Krupa Enterprise';
                    else if (cLower.includes('sham')) contractor = 'SHAM';
                    else if (cLower.includes('vasudeva')) contractor = 'VASUDEVA';
                    else if (cLower.includes('yashaswi')) contractor = 'YASHASWI';

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
