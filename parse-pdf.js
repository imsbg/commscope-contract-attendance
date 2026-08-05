const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

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
    
    let newGlobalData = [];
    let currentMonthStr = "Unknown Month";

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const rows = {};
        
        textContent.items.forEach(item => {
            const text = item.str.trim();
            if (!text) return;
            const y = item.transform[5];
            let rowY = Object.keys(rows).find(key => Math.abs(key - y) <= 4);
            if (!rowY) { rowY = y; rows[rowY] = []; }
            rows[rowY].push({ text: text, x: item.transform[4] });
        });
        
        Object.values(rows).forEach(rowItems => {
            const sortedItems = rowItems.sort((a, b) => a.x - b.x).map(item => item.text);
            const rowText = sortedItems.join(" ");
            
            if (currentMonthStr === "Unknown Month" && rowText.toLowerCase().includes("attendance for the month of")) {
                const match = rowText.match(/Attendance for the Month of\s*([A-Za-z]+\s*\d{4})/i);
                if (match) currentMonthStr = match[1];
            }
            
            let statusIdx = sortedItems.findIndex(str => str.toLowerCase() === 'active' || str.toLowerCase() === 'left');
            
            if (statusIdx !== -1 && sortedItems.length >= 6 && !sortedItems[0].toLowerCase().includes("employee")) {
                let code = sortedItems[0];
                let name = sortedItems.slice(1, statusIdx).join(' ');
                let status = sortedItems[statusIdx];
                let contractor = sortedItems[statusIdx + 1];
                let tl = sortedItems[sortedItems.length - 2];
                let sanctioner = sortedItems[sortedItems.length - 1];
                
                let datesArray = sortedItems.slice(statusIdx + 2, sortedItems.length - 2);
                while (datesArray.length < 31) datesArray.push('-');

                newGlobalData.push({ code, name, status, contractor, dates: datesArray, tl, sanctioner });
            }
        });
    }

    console.log(`✅ Successfully parsed ${newGlobalData.length} records for ${currentMonthStr}.`);

    // --- HISTORICAL ARCHIVE LOGIC ---
    let archive = { currentMonth: "", months: {} };
    
    // Check if data.json already exists to keep old months safe!
    if (fs.existsSync('data.json')) {
        try {
            const raw = fs.readFileSync('data.json');
            archive = JSON.parse(raw);
            
            // Automatic migration: If the old file uses the old layout, upgrade it seamlessly
            if (archive.globalData) {
                const oldMonth = archive.currentMonthStr || "July 2026";
                archive.months = {};
                archive.months[oldMonth] = archive.globalData;
                delete archive.globalData;
                delete archive.currentMonthStr;
            }
        } catch (e) {
            console.log("Could not parse old data.json, starting fresh archive.");
        }
    }

    // Safely insert the newly fetched month into the archive
    archive.currentMonth = currentMonthStr;
    if (!archive.months) archive.months = {};
    archive.months[currentMonthStr] = newGlobalData;
    
    // Save the upgraded archive
    fs.writeFileSync('data.json', JSON.stringify(archive));
    console.log("🚀 Saved to data.json with full historical archive!");
}

fetchAndParsePDF().catch(err => {
    console.error("❌ Fatal Error:", err.message);
    process.exit(1);
});
