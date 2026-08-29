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
        
        // BULLETPROOF Y-TOLERANCE: 
        // Prevents rows from breaking if text is slightly misaligned in the PDF.
        textContent.items.forEach(item => {
            const text = item.str.trim();
            if (!text) return;
            const y = item.transform[5];
            
            let rowY = Object.keys(rows).find(key => Math.abs(key - y) <= 4);
            if (!rowY) {
                rowY = y;
                rows[rowY] = [];
            }
            rows[rowY].push({ text: text, x: item.transform[4] });
        });
        
        Object.values(rows).forEach(rowItems => {
            // Sort left-to-right to recreate the exact table row
            const sortedItems = rowItems.sort((a, b) => a.x - b.x).map(item => item.text);
            const rowText = sortedItems.join(" ");
            
            // Extract Month Header
            if (currentMonthStr === "Unknown Month" && rowText.toLowerCase().includes("attendance for the month of")) {
                const match = rowText.match(/Attendance for the Month of\s*([A-Za-z]+\s*\d{4})/i);
                if (match) currentMonthStr = match[1];
            }
            
            // DYNAMIC COLUMN PARSING:
            // Find the exact index of the Status column (handles invisible spaces and capitalization)
            let statusIdx = sortedItems.findIndex(str => str.toLowerCase() === 'active' || str.toLowerCase() === 'left');
            
            // If it's a valid employee row (has a status, and is not the header row)
            if (statusIdx !== -1 && sortedItems.length >= 6 && !sortedItems[0].toLowerCase().includes("employee")) {
                
                let code = sortedItems[0];
                
                // Slice catches the full name perfectly even if PDF.js splits it
                let name = sortedItems.slice(1, statusIdx).join(' ');
                let status = sortedItems[statusIdx];
                let contractor = sortedItems[statusIdx + 1];
                
                // The last two columns are always Reporting Person and Sanctioner
                let tl = sortedItems[sortedItems.length - 2];
                let sanctioner = sortedItems[sortedItems.length - 1];
                
                // DYNAMIC DATES: Automatically captures everything between Contractor and TL.
                // Works perfectly whether it's Day 1, Day 15, or Day 31!
                let datesArray = sortedItems.slice(statusIdx + 2, sortedItems.length - 2);
                
                // Automatically pad the missing days of the month with blank dashes
                while (datesArray.length < 31) {
                    datesArray.push('-');
                }

                globalData.push({ 
                    code, name, status, contractor, dates: datesArray, tl, sanctioner 
                });
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
