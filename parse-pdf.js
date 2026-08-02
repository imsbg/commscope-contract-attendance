const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const PDF_FILE_ID = "YOUR_PDF_FILE_ID_HERE"; // <--- REPLACE THIS ID

async function fetchAndParsePDF() {
    console.log("Downloading PDF from Google Drive...");
    const driveUrl = `https://drive.google.com/uc?export=download&id=${PDF_FILE_ID}`;
    
    const response = await fetch(driveUrl);
    if (!response.ok) throw new Error("Failed to download PDF from Drive");
    
    const arrayBuffer = await response.arrayBuffer();
    const pdfData = new Uint8Array(arrayBuffer);
    
    console.log("Parsing PDF...");
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
            
            if (sortedItems.length >= 28 && !sortedItems[0].toLowerCase().includes("employee")) {
                globalData.push({ 
                    code: sortedItems[0], name: sortedItems[1], status: sortedItems[2], 
                    contractor: sortedItems[3], dates: sortedItems.slice(4, -2), 
                    tl: sortedItems.slice(-2, -1)[0], sanctioner: sortedItems.slice(-1)[0] 
                });
            }
        });
    }

    console.log(`Successfully parsed ${globalData.length} records.`);
    
    // Save to data.json
    fs.writeFileSync('data.json', JSON.stringify({ currentMonthStr, globalData }));
    console.log("Saved to data.json");
}

fetchAndParsePDF().catch(err => {
    console.error(err);
    process.exit(1);
});
