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

    // Global Grid Tracking
    let globalDateBins = new Array(31).fill(null);
    let globalRepX = 9999;
    let globalSancX = 9999;

    const attCodes = new Set(['p', 'a', 'wo', 'hd', 'fd', 'slwp', 'lwp', 'mp', 'l', '-', '--', 'ho', 'rota', 'ho(rota)', 'pl', 'wwo', 'cf', 'who', 'who(rota)']);

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        let items = textContent.items
            .map(item => ({ text: item.str.trim(), x: item.transform[4], y: item.transform[5] }))
            .filter(item => item.text !== '');

        if (items.length === 0) continue;

        // 1. EXTRACT MONTH
        let fullPageText = items.map(itm => itm.text).join(' ');
        let monthMatch = fullPageText.match(/Month\s*of\s*([A-Za-z]+)\s*(\d{4})/i);
        if (monthMatch && currentMonthStr === "Unknown Month") {
            currentMonthStr = monthMatch[1] + " " + monthMatch[2];
        }

        // 2. DETECT COLUMN HEADERS
        let repHeader = items.find(itm => itm.text.toLowerCase().includes('reporting'));
        let sancHeader = items.find(itm => itm.text.toLowerCase().includes('sanctioner'));
        
        if (repHeader) globalRepX = repHeader.x;
        if (sancHeader) globalSancX = sancHeader.x;

        let headerRowY = repHeader ? repHeader.y : (sancHeader ? sancHeader.y : null);

        // 3. EXTRAPOLATE CALENDAR GRID (Only needs to run once successfully)
        if (headerRowY !== null && globalDateBins[0] === null) {
            let dayHeaders = items.filter(itm => Math.abs(itm.y - headerRowY) < 12 && /^\d{1,2}$/.test(itm.text));
            
            if (dayHeaders.length > 0) {
                dayHeaders.sort((a,b) => a.x - b.x);
                dayHeaders.forEach(h => {
                    let day = parseInt(h.text);
                    if (day >= 1 && day <= 31) globalDateBins[day - 1] = h.x;
                });

                let gap = 18.5; // Default column width
                let gaps = [];
                for(let k = 1; k < dayHeaders.length; k++) {
                    let d = dayHeaders[k].x - dayHeaders[k-1].x;
                    if (d > 5 && d < 35) gaps.push(d); 
                }
                if (gaps.length > 0) {
                    gaps.sort((a,b) => a - b);
                    gap = gaps[Math.floor(gaps.length / 2)]; 
                }

                // Extrapolate perfectly across 31 days
                for (let k = 30; k >= 0; k--) {
                    if (globalDateBins[k] !== null) {
                        for (let j = k - 1; j >= 0; j--) {
                            if (globalDateBins[j] === null) globalDateBins[j] = globalDateBins[j+1] - gap;
                        }
                        for (let j = k + 1; j < 31; j++) {
                            if (globalDateBins[j] === null) globalDateBins[j] = globalDateBins[j-1] + gap;
                        }
                        break;
                    }
                }
            }
        }

        // 4. GROUP BY Y-COORDINATES (Magnetic binding for rows)
        items.sort((a, b) => {
            if (Math.abs(b.y - a.y) > 5) return b.y - a.y;
            return a.x - b.x;
        });

        let lines = [];
        let currentRow = [];
        let lastY = null;
        for (let item of items) {
            if (lastY === null || Math.abs(item.y - lastY) > 6) {
                if (currentRow.length > 0) lines.push(currentRow);
                currentRow = [item];
                lastY = item.y;
            } else {
                currentRow.push(item);
            }
        }
        if (currentRow.length > 0) lines.push(currentRow);

        // 5. PROCESS EACH ROW VIA BULLETPROOF REGEX
        for (let line of lines) {
            // Re-bind HO (ROTA) if split
            for (let j = 0; j < line.length; j++) {
                if (line[j].text.trim() === 'HO' && line[j+1] && line[j+1].text.trim() === '(ROTA)') {
                    line[j].text = 'HO (ROTA)';
                    line.splice(j+1, 1);
                    j--;
                }
            }

            let fullText = line.map(i => i.text).join(' ');
            
            // MAGIC REGEX: Captures [Code] [Name] [Status] [Contractor] safely regardless of weird spaces
            let match = fullText.match(/^([A-Z0-9]{2,6}\s*-?\s*\d{3,8})\s*(.+?)\s*(Active|Left)\s*(ADECCO|ANANYA|Dibya[\w\s]*|ESJAY|MATHEW|Om\s*Sai[\w\s]*|SHAM|VASUDEVA|YASHASWI|\S+)/i);
            
            if (!match) {
                // Diagnostic logging to catch edge cases in GitHub Actions log
                if (fullText.toLowerCase().includes('active') && /[0-9]/.test(fullText)) {
                    console.log("⚠️ Skipped potential row (Regex failed): " + fullText);
                }
                continue;
            }

            let code = match[1].replace(/\s+/g, '');
            let name = match[2].replace(/^[-\s]+/, '').trim();
            let status = match[3].charAt(0).toUpperCase() + match[3].slice(1).toLowerCase();
            let contractorRaw = match[4];

            // Normalize Contractor Name
            let contractor = "Unknown";
            let cLow = contractorRaw.toLowerCase();
            if (cLow.includes('adecco')) contractor = 'ADECCO';
            else if (cLow.includes('ananya')) contractor = 'ANANYA';
            else if (cLow.includes('dibya')) contractor = 'Dibya Industrial Service';
            else if (cLow.includes('esjay')) contractor = 'ESJAY';
            else if (cLow.includes('mathew')) contractor = 'MATHEW';
            else if (cLow.includes('om sai')) contractor = 'Om Sai Krupa Enterprise';
            else if (cLow.includes('sham')) contractor = 'SHAM';
            else if (cLow.includes('vasudeva')) contractor = 'VASUDEVA';
            else if (cLow.includes('yashaswi')) contractor = 'YASHASWI';
            else contractor = contractorRaw;

            // Map Attendance and Supervisors dynamically via X coordinates
            let datesArray = new Array(31).fill('-');
            let supItems = [];

            for (let item of line) {
                let tLow = item.text.toLowerCase().replace(/\s*\(pending\)/g, '').replace(/\s+/g, '');
                
                // If it's on the right side, it's a supervisor
                if (globalRepX !== 9999 && item.x >= (globalRepX - 25)) {
                    supItems.push(item);
                } else {
                    // If it's an attendance code, snap it to the calendar grid
                    if (attCodes.has(tLow)) {
                        let closestIdx = -1;
                        let minDiff = 16; 
                        
                        if (globalDateBins[0] !== null) {
                            for (let k = 0; k < 31; k++) {
                                if (globalDateBins[k] !== null) {
                                    let diff = Math.abs(item.x - globalDateBins[k]);
                                    if (diff < minDiff) {
                                        minDiff = diff;
                                        closestIdx = k;
                                    }
                                }
                            }
                        }
                        
                        if (closestIdx !== -1) {
                            datesArray[closestIdx] = (tLow === 'ho(rota)' ? 'HO (ROTA)' : item.text.trim());
                        } else if (globalDateBins[0] === null) {
                            // Absolute fallback if grid fails to build
                            let emptySlot = datesArray.findIndex(d => d === '-');
                            if(emptySlot !== -1) datesArray[emptySlot] = item.text.trim();
                        }
                    }
                }
            }

            // Map TL and Sanctioner safely
            let tl = "N/A", sanctioner = "N/A";
            if (globalSancX !== 9999) {
                let tlArr = supItems.filter(u => u.x < globalSancX - 15).map(u => u.text);
                let sancArr = supItems.filter(u => u.x >= globalSancX - 15).map(u => u.text);
                if (tlArr.length > 0) tl = tlArr.join(' ');
                if (sancArr.length > 0) sanctioner = sancArr.join(' ');
            } else {
                let supTexts = supItems.map(u => u.text);
                if (supTexts.length >= 2) {
                    let half = Math.floor(supTexts.length / 2);
                    tl = supTexts.slice(0, half).join(' ');
                    sanctioner = supTexts.slice(half).join(' ');
                } else if (supTexts.length > 0) {
                    tl = supTexts[0];
                }
            }

            if (name.length > 2) {
                globalData.push({ code, name, status, contractor, dates: datesArray, tl, sanctioner });
            }
        }
    }

    if (globalDateBins[0] === null) {
        console.log("⚠️ WARNING: Could not find Day '1' to build Calendar Grid. Data might be shifted.");
    }

    console.log(`✅ Successfully parsed ${globalData.length} employee records.`);
    fs.writeFileSync('data.json', JSON.stringify({ currentMonthStr, globalData }));
    console.log("🚀 Saved to data.json successfully!");
}

fetchAndParsePDF().catch(err => { 
    console.error("❌ Fatal Error:", err.message);
    process.exit(1); 
});
