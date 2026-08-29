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
    
    // This will hold the exact X coordinates of columns 1 through 31
    let globalDayXCoords = new Array(31).fill(null);

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        let items = textContent.items
            .map(item => ({ text: item.str.trim(), x: item.transform[4], y: item.transform[5] }))
            .filter(item => item.text !== '');

        // 1. EXTRACT MONTH
        let fullPageText = items.map(item => item.text).join(' ');
        const monthMatch = fullPageText.match(/Attendance for the Month of\s*([A-Za-z]+\s*\d{4})/i);
        if (monthMatch && currentMonthStr === "Unknown Month") {
            currentMonthStr = monthMatch[1];
        }

        // 2. STABLE 2D SORT
        items.sort((a, b) => {
            if (Math.abs(b.y - a.y) > 3) return b.y - a.y; 
            return a.x - b.x; 
        });

        // 3. BUILD THE SPATIAL GRID MAP (Measure the exact column locations)
        let headerCodeItem = items.find(u => u.text.toLowerCase() === 'employee code');
        if (headerCodeItem) {
            let headerY = headerCodeItem.y;
            let headerItems = items.filter(u => Math.abs(u.y - headerY) < 6);
            for (let d = 1; d <= 31; d++) {
                // Find where the column numbers are physically located (between X=180 and X=750)
                let match = headerItems.find(u => u.text === d.toString() && u.x > 180 && u.x < 750);
                if (match) globalDayXCoords[d - 1] = match.x;
            }
            // Auto-fill minor gaps (e.g., if Day 2 didn't parse, average Day 1 and Day 3)
            for (let d = 1; d < 30; d++) {
                if (!globalDayXCoords[d] && globalDayXCoords[d-1] && globalDayXCoords[d+1]) {
                    globalDayXCoords[d] = (globalDayXCoords[d-1] + globalDayXCoords[d+1]) / 2;
                }
            }
        }

        // Fallback grid if the header row is missing or completely broken
        if (!globalDayXCoords[0]) {
            for(let d=0; d<31; d++) globalDayXCoords[d] = 230 + (d * 15.6);
        }

        // 4. ANCHOR GROUPING (Splits rows exactly on Employee Code)
        let lines = [];
        let currentRow = [];

        for (let item of items) {
            let t = item.text.toLowerCase();
            if (t === 'page' || t === 'of') continue; // Destroy footers
            
            const isEmployeeCode = /^[A-Z0-9]{2,6}-\d{3,8}$/i.test(item.text) && item.x < 150;

            if (isEmployeeCode) {
                if (currentRow.length > 0) lines.push(currentRow);
                currentRow = [item];
            } else if (currentRow.length > 0) {
                if (/^\d+$/.test(item.text) && parseInt(item.text) > 31) continue; // Ignore page numbers
                currentRow.push(item);
            }
        }
        if (currentRow.length > 0) lines.push(currentRow);

        // 5. PROCESS ZONES (Using Physical X Coordinates)
        for (let row of lines) {
            row.sort((a, b) => a.x - b.x);

            // Sanitize text & remove duplicates
            let cleanRow = [];
            for (let i = 0; i < row.length; i++) {
                let t = row[i].text.replace(/\s*\(Pending\)/ig, '').trim(); // Remove (Pending)
                if (t === 'HO' && row[i+1] && row[i+1].text === '(ROTA)') {
                    t = 'HO (ROTA)';
                    i++; 
                }
                let isDuplicate = cleanRow.some(u => u.text === t && Math.abs(u.x - row[i].x) < 10);
                if (!isDuplicate) cleanRow.push({ text: t, x: row[i].x });
            }

            let statusIdx = cleanRow.findIndex(u => u.text.toLowerCase() === 'active' || u.text.toLowerCase() === 'left');
            
            if (statusIdx >= 1) {
                let code = cleanRow[0].text;
                let name = cleanRow.slice(1, statusIdx).map(u=>u.text).join(' ');
                let status = cleanRow[statusIdx].text;
                
                let contractorItems = [];
                let gridItems = [];
                let leaderItems = [];

                // Define strict physical boundaries
                let gridStartX = globalDayXCoords[0] - 12;
                let gridEndX = globalDayXCoords[30] ? globalDayXCoords[30] + 15 : 720;

                // Sort items into their physical zones
                for (let i = statusIdx + 1; i < cleanRow.length; i++) {
                    let item = cleanRow[i];
                    if (item.x < gridStartX) contractorItems.push(item.text);
                    else if (item.x >= gridStartX && item.x <= gridEndX) gridItems.push(item);
                    else leaderItems.push(item.text);
                }

                // SMART CONTRACTOR SANITIZER
                let rawContractor = contractorItems.join(' ');
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
                else contractor = contractor.replace(/left|active/ig, '').trim();

                // ATTENDANCE GRID PLACEMENT (Maps to specific day based on physical coordinate)
                let datesArray = new Array(31).fill('-');
                const attCodes = new Set(['p', 'a', 'wo', 'hd', 'fd', 'slwp', 'lwp', 'pl', 'hp', 'mp', 'l', '-', '--', 'ho', 'rota', 'ho (rota)']);
                
                for (let item of gridItems) {
                    if (attCodes.has(item.text.toLowerCase())) {
                        let bestDay = -1;
                        let minDiff = 15; // Tolerance for placement
                        
                        // Check which exact day column this item is closest to
                        for (let d = 0; d < 31; d++) {
                            if (globalDayXCoords[d]) {
                                let diff = Math.abs(item.x - globalDayXCoords[d]);
                                if (diff < minDiff) {
                                    minDiff = diff;
                                    bestDay = d;
                                }
                            }
                        }
                        if (bestDay !== -1) datesArray[bestDay] = item.text;
                    }
                }

                // LEADERS ZONE
                let tl = "N/A", sanctioner = "N/A";
                if (leaderItems.length >= 2) {
                    let half = Math.floor(leaderItems.length / 2);
                    tl = leaderItems.slice(0, half).join(' ');
                    sanctioner = leaderItems.slice(half).join(' ');
                } else if (leaderItems.length === 1) {
                    tl = leaderItems[0];
                }

                if (code.length > 2 && name.length > 2) {
                    globalData.push({ code, name, status, contractor, dates: datesArray, tl, sanctioner });
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
