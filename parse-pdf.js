const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

// Your EXACT working Google Apps Script URL
const GAS_URL = "https://script.google.com/macros/s/AKfycbzBMx-fZAifindtXbsXVueYEYQz4uBT1cA8CnlrZH3MTHEyR4RMv6uxaPhdKwskiP4T/exec";

async function fetchAndParsePDF() {
    console.log("🌐 Fetching PDF from Google Apps Script...");
    
    // Fetch using the built-in Node fetch
    const response = await fetch(GAS_URL);
    if (!response.ok) throw new Error("Network response was not ok");
    
    const json = await response.json();
    if (!json.success) throw new Error("GAS Error: " + json.error);
    
    console.log("📦 Decoding Base64 PDF data...");
    // Convert base64 from your GAS back into a usable PDF buffer
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
        textContent.items.forEach(item => {
            if (!item.str.trim()) return;
            const y = Math.round(item.transform[5]);
            if (!rows[y]) rows[y] = [];
            rows[y].push({ text: item.str.trim(), x: item.transform[4] });
        });
        
        Object.values(rows).forEach(rowItems => {
            const sortedItems = rowItems.sort((a, b) => a.x - b.x).map(item => item.text);
            const rowText = sortedItems.join(" ");
            
            if (currentMonthStr === "Unknown Month" && rowText.toLowerCase().includes("attendance for the month of")) {
                const match = rowText.match(/Attendance for the Month of\s*([A-Za-z]+\s*\d{4})/i);
                if (match) currentMonthStr = match[1];
            }
            
            // SMART FIX FOR NEW MONTHS: 
            // We lowered the required items from 28 to 6, because at the start of the month, 
            // there are only a few days of data. We check for "Active" or "Left" to ensure it's an employee row.
            const hasStatus = sortedItems[2] === "Active" || sortedItems[2] === "Left";
            
            if (sortedItems.length >= 6 && !sortedItems[0].toLowerCase().includes("employee") && hasStatus) {
                
                // Extract whatever days exist (e.g. only 2 days for August 2nd)
                let datesArray = sortedItems.slice(4, -2);
                
                // Pad the remaining days of the month with blank dashes so the frontend calendar doesn't break
                while (datesArray.length < 31) {
                    datesArray.push('-');
                }

                globalData.push({ 
                    code: sortedItems[0], 
                    name: sortedItems[1], 
                    status: sortedItems[2], 
                    contractor: sortedItems[3], 
                    dates: datesArray, 
                    tl: sortedItems.slice(-2, -1)[0], 
                    sanctioner: sortedItems.slice(-1)[0] 
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
