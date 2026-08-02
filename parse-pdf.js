const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

// The exact Folder and File Name you provided
const FOLDER_ID = "1H5tR99F-DsbT9wQnlLqXST0aLsa0B1sO";
const FILE_NAME = "Shopfloor_Attendance_Current.pdf";

async function getFileIdFromFolder(folderId, fileName) {
    console.log(`🔍 Scraping Google Drive Folder (${folderId}) to find ID for ${fileName}...`);
    const url = `https://drive.google.com/drive/folders/${folderId}`;
    
    // Disguise the request as a real Chrome browser to bypass Google's bot protection
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    });
    
    if (!response.ok) {
        throw new Error(`Failed to load folder URL. HTTP ${response.status}`);
    }
    
    const html = await response.text();
    
    // Search the Google Drive HTML for the File ID that immediately precedes our File Name.
    // Google Drive File IDs are typically 25 to 40 characters long.
    const escapedFileName = fileName.replace(/\./g, '\\.');
    const regex = new RegExp(`([a-zA-Z0-9_-]{25,40})(?:[^a-zA-Z0-9_-]{1,50}?)${escapedFileName}`, 'i');
    
    const match = html.match(regex);
    if (!match) {
        throw new Error(`❌ Could not find "${fileName}" in folder. Make sure the file exists and the folder is Public.`);
    }
    
    const fileId = match[1];
    console.log(`✅ Found File ID: ${fileId}`);
    return fileId;
}

async function fetchAndParsePDF() {
    // 1. Get the dynamic file ID directly from the folder
    const fileId = await getFileIdFromFolder(FOLDER_ID, FILE_NAME);

    console.log(`⬇️ Downloading PDF from Google Drive...`);
    const driveUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    
    const response = await fetch(driveUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' },
        redirect: 'follow'
    });
    
    if (!response.ok) {
        throw new Error(`❌ Failed to download PDF. HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('text/html')) {
        throw new Error("❌ Google Drive returned a webpage instead of the PDF. Google might be blocking it with a virus scan warning.");
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const pdfData = new Uint8Array(arrayBuffer);
    
    console.log(`✅ PDF downloaded successfully! Size: ${(pdfData.length / 1024 / 1024).toFixed(2)} MB`);
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
            
            if (sortedItems.length >= 28 && !sortedItems[0].toLowerCase().includes("employee")) {
                globalData.push({ 
                    code: sortedItems[0], name: sortedItems[1], status: sortedItems[2], 
                    contractor: sortedItems[3], dates: sortedItems.slice(4, -2), 
                    tl: sortedItems.slice(-2, -1)[0], sanctioner: sortedItems.slice(-1)[0] 
                });
            }
        });
    }

    console.log(`✅ Successfully parsed ${globalData.length} employee records.`);
    
    // Save to data.json
    fs.writeFileSync('data.json', JSON.stringify({ currentMonthStr, globalData }));
    console.log("🚀 Saved to data.json!");
}

fetchAndParsePDF().catch(err => {
    console.error(err.message);
    process.exit(1);
});
