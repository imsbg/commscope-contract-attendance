const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const puppeteer = require('puppeteer');

// The exact Folder and File Name you provided
const FOLDER_ID = "1H5tR99F-DsbT9wQnlLqXST0aLsa0B1sO";
const FILE_NAME = "Shopfloor_Attendance_Current.pdf";

async function getFileId(folderId, fileName) {
    console.log(`🔍 Launching headless browser to load Google Drive folder...`);
    const browser = await puppeteer.launch({ 
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    
    const page = await browser.newPage();
    const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;
    
    console.log(`🌐 Navigating to ${folderUrl} and waiting for files to render...`);
    // This waits for Google Drive's JavaScript to fully load the files on the screen
    await page.goto(folderUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    
    console.log(`📄 Scanning the page for "${fileName}"...`);
    
    const fileId = await page.evaluate((searchName) => {
        // Strategy 1: Find element with data-id containing the filename
        const elements = document.querySelectorAll('div[data-id]');
        for (const el of elements) {
            const text = el.innerText || "";
            const ariaLabel = el.getAttribute('aria-label') || "";
            if (text.includes(searchName) || ariaLabel.includes(searchName)) {
                return el.getAttribute('data-id');
            }
        }
        
        // Strategy 2: Absolute fallback, regex on fully rendered HTML
        const html = document.body.innerHTML;
        const escaped = searchName.replace(/\./g, '\\.');
        const regex = new RegExp(`([a-zA-Z0-9_-]{25,40})(?:[^a-zA-Z0-9_-]{1,150}?)${escaped}`, 'i');
        const match = html.match(regex);
        if (match) return match[1];

        return null;
    }, FILE_NAME);
    
    await browser.close();
    
    if (!fileId) {
        throw new Error(`❌ Could not find "${fileName}" in folder. Ensure the folder is public and the file exists.`);
    }
    
    console.log(`✅ Found exact File ID: ${fileId}`);
    return fileId;
}

async function fetchAndParsePDF() {
    const fileId = await getFileId(FOLDER_ID, FILE_NAME);

    console.log(`⬇️ Downloading PDF from Google Drive...`);
    const driveUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    
    const response = await fetch(driveUrl, {
        headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
        },
        redirect: 'follow'
    });
    
    if (!response.ok) {
        throw new Error(`❌ Failed to download PDF. HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('text/html')) {
        throw new Error("❌ Google Drive returned a webpage instead of the PDF. Check if the folder is Public.");
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
    fs.writeFileSync('data.json', JSON.stringify({ currentMonthStr, globalData }));
    console.log("🚀 Saved to data.json!");
}

fetchAndParsePDF().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
});
