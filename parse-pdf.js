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
    
    let globalData = [];
    let currentMonthStr = "Unknown Month";
    
    // Memory Grid for physical X-coordinates of Days 1-31
    let globalDayXCoords = new Array(31).fill(null);

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        let items = textContent.items
            .map(item => ({ text: item.str.trim(), x: item.transform[4], y: item.transform[5] }))
            .filter(item => item.text !== '');

        // 1. EXTRACT MONTH (Runs on first page)
        if (currentMonthStr === "Unknown Month") {
            let fullPageText = items.map(item => item.text).join(' ');
            const monthMatch = fullPageText.match(/Attendance for the Month of\s*([A-Za-z]+\s*\d{4})/i);
            if (monthMatch) currentMonthStr = monthMatch[1];
        }

        // 2. STABLE 2D SORT (Top to Bottom, Left to Right)
        items.sort((a, b) => {
            if (Math.abs(b.y - a.y) > 4) return b.y - a.y; 
            return a.x - b.x; 
        });

        // 3. BUILD THE SPATIAL GRID (Only runs once, remembers for all pages)
        if (!globalDayXCoords[0]) {
            // Find the word "Contractor" in the header to anchor our vertical height
            let headerAnchor = items.find(u => u.text.toLowerCase() === 'contractor');
            if (headerAnchor) {
                // Grab everything within a generous 15-pixel horizontal band
                let headerRow = items.filter(u => Math.abs(u.y - headerAnchor.y) < 15);
                
                for (let d = 1; d <= 31; d++) {
                    let match = headerRow.find(u => u.text === d.toString());
                    if (match) globalDayXCoords[d-1] = match.x;
                }
                
                // Auto-fill tiny gaps if a number was blurry
                for (let d = 1; d < 30; d++) {
                    if (!globalDayXCoords[d] && globalDayXCoords[d-1] && globalDayXCoords[d+1]) {
                        globalDayXCoords[d] = (globalDayXCoords[d-1] + globalDayXCoords[d+1]) / 2;
                    }
                }
            }
            
            // Fallback just in case the PDF completely breaks (prevents 0 data)
            if (!globalDayXCoords[0]) {
                for(let d=0; d<31; d++) globalDayXCoords[d] = 215 + (d * 14.5); 
            }
        }

        // 4. ANCHOR GROUPING (Splits rows exactly on Employee Code)
        let lines = [];
        let currentRow = [];

        for (let item of items) {
            let t = item.text.toLowerCase();
            
            // Destroy all header/footer words so they don't enter our data
            if (t === 'employee code' || t === 'employee name' || t === 'status' || t === 'contractor' || t === 'reporting person' || t === 'sanctioner') continue;
            if (t === 'page' || t === 'of') continue; 
            
            // Skip stray page numbers
            if (/^\d+$/.test(item.text) && parseInt(item.text) > 31) continue; 
            
            // Detect the start of a new employee row
            const isEmployeeCode = /^[A-Z0-9]{2,6}-\d{3,8}$/i.test(item.text) && item.x < 150;

            if (isEmployeeCode) {
                if (currentRow.length > 0) lines.push(currentRow);
                currentRow = [item];
            } else if (currentRow.length > 0) {
                // By only pushing when currentRow has data, we automatically ignore 
                // the "1 2 3... 31" header numbers on Pages 2-38!
                currentRow.push(item);
            }
        }
        if (currentRow.length > 0) lines.push(currentRow);

        // 5. PROCESS ROWS INTO ZONES
        let gridStartX = (globalDayXCoords[0] || 215) - 12;
        let gridEndX = (globalDayXCoords[30] || 650) + 15; 

        for (let row of lines) {
            row.sort((a, b) => a.x - b.x);

            // Clean text inside the row
            let cleanRow = [];
            for (let j = 0; j < row.length; j++) {
                let t = row[j].text.replace(/\s*\(Pending\)/ig, '').trim();
                if (t === 'HO' && row[j+1] && row[j+1].text === '(ROTA)') {
                    t = 'HO (ROTA)';
                    j++; 
                }
                let isDuplicate = cleanRow.some(u => u.text === t && Math.abs(u.x - row[j].x) < 8);
                if (!isDuplicate && t !== '') cleanRow.push({ text: t, x: row[j].x });
            }

            // Split into 3 physical zones
            let leftItems = cleanRow.filter(i => i.x < gridStartX).map(i => i.text);
            let gridItems = cleanRow.filter(i => i.x >= gridStartX && i.x <= gridEndX);
            let rightItems = cleanRow.filter(i => i.x > gridEndX).map(i => i.text);

            let statusIdx = leftItems.findIndex(str => str.toLowerCase() === 'active' || str.toLowerCase() === 'left');
            
            if (statusIdx >= 1 && leftItems.length >= 3) {
                let code = leftItems[0];
                let name = leftItems.slice(1, statusIdx).join(' ');
                let status = leftItems[statusIdx];
                
                // SMART CONTRACTOR SANITIZER
                let rawContractor = leftItems.slice(statusIdx + 1).join(' ');
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

                // ATTENDANCE GRID SNAPPER
                let datesArray = new Array(31).fill('-');
                const attCodes = new Set(['p', 'a', 'wo', 'hd', 'fd', 'slwp', 'lwp', 'pl', 'hp', 'mp', 'l', '-', '--', 'ho', 'rota', 'ho (rota)']);
                
                for (let item of gridItems) {
                    if (attCodes.has(item.text.toLowerCase())) {
                        let bestDay = -1;
                        let minDiff = 12; // Snap tolerance
                        
                        for (let d = 0; d < 31; d++) {
                            if (globalDayXCoords[d] !== null) {
                                let diff = Math.abs(item.x - globalDayXCoords[d]);
                                if (diff < minDiff) {
                                    minDiff = diff;
                                    bestDay = d;
                                }
                            }
                        }
                        if (bestDay !== -1) datesArray[bestDay] = item.text.toUpperCase();
                    }
                }

                // TEAM LEADERS
                let tl = "N/A", sanctioner = "N/A";
                if (rightItems.length >= 2) {
                    let half = Math.floor(rightItems.length / 2);
                    tl = rightItems.slice(0, half).join(' ');
                    sanctioner = rightItems.slice(half).join(' ');
                } else if (rightItems.length === 1) {
                    tl = rightItems[0];
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
