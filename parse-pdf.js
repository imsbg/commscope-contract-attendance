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
    
    // Stores the physical X-coordinates of the 31 columns
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

        // 2. STABLE 2D SORT (Top-to-Bottom, Left-to-Right)
        items.sort((a, b) => {
            if (Math.abs(b.y - a.y) > 3) return b.y - a.y; 
            return a.x - b.x; 
        });

        // 3. ANCHOR GROUPING (Splits rows exactly on Employee Code)
        let lines = [];
        let currentRow = [];

        for (let item of items) {
            let t = item.text.toLowerCase();
            if (t === 'page' || t === 'of') continue; // Destroy footers
            
            // Is it an Employee ID on the far left?
            const isEmployeeCode = /^[A-Z0-9]{2,6}-\d{3,8}$/i.test(item.text) && item.x < 150;

            if (isEmployeeCode) {
                if (currentRow.length > 0) lines.push(currentRow);
                currentRow = [item];
            } else {
                // Also capture the Header Row to map columns
                if (currentRow.length === 0 && (item.text === '1' || item.text === 'Employee Code')) {
                    currentRow.push(item);
                }
                else if (currentRow.length > 0) {
                    if (/^\d+$/.test(item.text) && parseInt(item.text) > 31) continue; // Ignore page numbers
                    currentRow.push(item);
                }
            }
        }
        if (currentRow.length > 0) lines.push(currentRow);

        // 4. PROCESS ZONES (Left: Info, Middle: Grid, Right: Leaders)
        for (let line of lines) {
            line.sort((a, b) => a.x - b.x);

            // Is this the Header Row? (Update physical column coordinates)
            let isHeader = line.some(u => u.text === '1') && line.some(u => u.text === '15');
            if (isHeader) {
                for (let d = 1; d <= 31; d++) {
                    let item = line.find(u => u.text === d.toString() && u.x > 150); // x>150 ensures we don't grab IDs
                    if (item) globalDayXCoords[d-1] = item.x;
                }
                continue; 
            }

            // Anti-duplication filter
            let uniqueLine = [];
            for (let item of line) {
                let isDuplicate = uniqueLine.some(u => u.text === item.text && Math.abs(u.x - item.x) < 12);
                if (!isDuplicate) uniqueLine.push(item);
            }

            // Clean text (Remove Pending, merge HO ROTA)
            for (let j = 0; j < uniqueLine.length; j++) {
                uniqueLine[j].text = uniqueLine[j].text.replace(/\s*\(Pending\)/ig, '').trim();
                if (uniqueLine[j].text === 'HO' && uniqueLine[j+1] && uniqueLine[j+1].text === '(ROTA)') {
                    uniqueLine[j].text = 'HO (ROTA)';
                    uniqueLine.splice(j+1, 1);
                    j--;
                }
            }

            // Define physical boundary zones
            let gridStartX = globalDayXCoords[0] ? globalDayXCoords[0] - 15 : 200;
            let gridEndX = globalDayXCoords[30] ? globalDayXCoords[30] + 15 : 750;

            // ZONE 1: Employee Info (Left side of the page)
            let empItems = uniqueLine.filter(item => item.x < gridStartX).map(u => u.text);
            
            let statusIdx = empItems.findIndex(str => str.toLowerCase() === 'active' || str.toLowerCase() === 'left');
            
            if (statusIdx >= 1 && empItems.length >= 3) {
                let code = empItems[0];
                let name = empItems.slice(1, statusIdx).join(' ');
                let status = empItems[statusIdx];
                
                let rawContractor = empItems.slice(statusIdx + 1).join(' ');
                
                // Smart Contractor Sanitizer
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
                else contractor = contractor.replace(/left/ig, '').trim(); // Fallback clean

                // ZONE 2: Attendance Grid (Middle of the page - Exact Coordinate Placement)
                const attCodes = new Set(['p', 'a', 'wo', 'hd', 'fd', 'slwp', 'lwp', 'mp', 'l', '-', '--', 'ho', 'rota', 'ho (rota)']);
                let datesArray = new Array(31).fill('-');
                
                let gridItems = uniqueLine.filter(item => item.x >= gridStartX && item.x <= gridEndX);
                for (let item of gridItems) {
                    if (attCodes.has(item.text.toLowerCase())) {
                        let bestDay = -1;
                        let minDiff = 15; // Max tolerance
                        for (let d = 0; d < 31; d++) {
                            if (globalDayXCoords[d] !== null) {
                                let diff = Math.abs(item.x - globalDayXCoords[d]);
                                if (diff < minDiff) {
                                    minDiff = diff;
                                    bestDay = d;
                                }
                            }
                        }
                        if (bestDay !== -1) {
                            datesArray[bestDay] = item.text;
                        }
                    }
                }

                // ZONE 3: Leaders (Right side of the page)
                let leaderItems = uniqueLine.filter(item => item.x > gridEndX).map(u => u.text);
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
