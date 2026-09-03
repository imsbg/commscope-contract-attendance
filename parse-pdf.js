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

    // Track coordinates globally across pages
    let globalDateBins = new Array(31).fill(null);
    let globalRepX = 9999;
    let globalSancX = 9999;

    const attCodes = new Set(['p', 'a', 'wo', 'hd', 'fd', 'slwp', 'lwp', 'mp', 'l', '-', '--', 'ho', 'rota', 'ho (rota)', 'pl', 'wwo', 'cf', 'who', 'who (rota)']);

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        let items = textContent.items
            .map(item => ({ text: item.str.trim(), x: item.transform[4], y: item.transform[5] }))
            .filter(item => item.text !== '');

        // 1. EXTRACT MONTH
        let fullPageText = items.map(itm => itm.text).join(' ');
        const monthMatch = fullPageText.match(/Attendance for the Month of\s*([A-Za-z]+\s*\d{4})/i);
        if (monthMatch && currentMonthStr === "Unknown Month") {
            currentMonthStr = monthMatch[1];
        }

        // 2. DETECT EXACT COLUMN ZONES DYNAMICALLY
        let reportingItem = items.find(itm => itm.text.toLowerCase().includes('reporting'));
        let sancItem = items.find(itm => itm.text.toLowerCase().includes('sanctioner'));
        
        if (reportingItem) globalRepX = reportingItem.x - 10;
        if (sancItem) globalSancX = sancItem.x - 10;
        
        // Find Y-coordinate of the Table Header row
        let headerRowY = reportingItem ? reportingItem.y : (sancItem ? sancItem.y : null);
        
        if (headerRowY !== null) {
            let dayHeaders = items.filter(itm => 
                Math.abs(itm.y - headerRowY) < 10 && 
                /^\d{1,2}$/.test(itm.text) && 
                parseInt(itm.text) >= 1 && 
                parseInt(itm.text) <= 31
            );
            
            if (dayHeaders.length > 0) {
                dayHeaders.sort((a, b) => a.x - b.x);
                let localDateBins = new Array(31).fill(null);
                
                dayHeaders.forEach(h => {
                    let day = parseInt(h.text);
                    localDateBins[day - 1] = h.x;
                });
                
                // Calculate column width dynamically
                let gap = 18; // Default column gap
                if (dayHeaders.length >= 2) {
                    let gaps = [];
                    for(let k = 1; k < dayHeaders.length; k++) {
                        let d = dayHeaders[k].x - dayHeaders[k-1].x;
                        if (d > 5 && d < 40) gaps.push(d); 
                    }
                    if (gaps.length > 0) {
                        gaps.sort((a,b) => a - b);
                        gap = gaps[Math.floor(gaps.length / 2)];
                    }
                }
                
                // Extrapolate/fill-in missing day coordinates automatically (Even if only Day 1 exists)
                for (let k = 30; k >= 0; k--) {
                    if (localDateBins[k] !== null) {
                        // Backfill left
                        for (let j = k - 1; j >= 0; j--) {
                            if (localDateBins[j] === null) localDateBins[j] = localDateBins[j+1] - gap;
                        }
                        // Forward fill right
                        for (let j = k + 1; j < 31; j++) {
                            if (localDateBins[j] === null) localDateBins[j] = localDateBins[j-1] + gap;
                        }
                        break;
                    }
                }
                globalDateBins = localDateBins; // Lock it in for this & future pages
            }
        }

        // 3. STABLE 2D SORT (Top to Bottom, Left to Right)
        items.sort((a, b) => {
            if (Math.abs(b.y - a.y) > 5) return b.y - a.y; 
            return a.x - b.x; 
        });

        // 4. ANCHOR GROUPING (Splits into precise rows based on Employee Code)
        let lines = [];
        let currentRow = [];

        for (let item of items) {
            let t = item.text.toLowerCase();
            if (t === 'page' || t === 'of') continue; 
            
            // Loose X boundary to support horizontal table shifts
            const isEmployeeCode = /^[A-Z0-9]{2,6}-\d{3,8}$/i.test(item.text);

            if (isEmployeeCode) {
                if (currentRow.length > 0) lines.push(currentRow);
                currentRow = [item];
            } else {
                if (currentRow.length > 0) {
                    if (/^\d+$/.test(item.text) && parseInt(item.text) > 31) continue; 
                    currentRow.push(item);
                }
            }
        }
        if (currentRow.length > 0) lines.push(currentRow);

        // 5. PROCESS EACH ROW USING THE X-COORD ZONES
        for (let line of lines) {
            line.sort((a, b) => a.x - b.x);

            let uniqueLine = [];
            for (let item of line) {
                let isDuplicate = uniqueLine.some(u => u.text === item.text && Math.abs(u.x - item.x) < 10);
                if (!isDuplicate) uniqueLine.push(item);
            }

            // Cleanup text combinations (E.g. HO (ROTA) parsed as split objects)
            for (let j = 0; j < uniqueLine.length; j++) {
                uniqueLine[j].text = uniqueLine[j].text.replace(/\s*\(Pending\)/ig, '').trim();
                if (uniqueLine[j].text === 'HO' && uniqueLine[j+1] && uniqueLine[j+1].text === '(ROTA)') {
                    uniqueLine[j].text = 'HO (ROTA)';
                    uniqueLine.splice(j+1, 1);
                    j--;
                }
            }

            let sortedTexts = uniqueLine.map(u => u.text);
            let statusIdx = uniqueLine.findIndex(u => u.text.toLowerCase() === 'active' || u.text.toLowerCase() === 'left');
            
            if (statusIdx >= 1) {
                let code = sortedTexts[0];
                let name = sortedTexts.slice(1, statusIdx).join(' ');
                let status = sortedTexts[statusIdx];
                
                // --- ZONE 1: Parse Contractor ---
                let contractor = "Unknown";
                let cEndIdx = statusIdx;
                for (let j = statusIdx + 1; j < uniqueLine.length; j++) {
                    let wLower = uniqueLine[j].text.toLowerCase();
                    // Stop if we hit an attendance code OR cross the Supervisor X-Boundary
                    if (attCodes.has(wLower) || uniqueLine[j].x >= globalRepX) {
                        break;
                    }
                    cEndIdx = j;
                }
                
                if (cEndIdx > statusIdx) {
                    let rawContractor = sortedTexts.slice(statusIdx + 1, cEndIdx + 1).join(' ');
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
                    else contractor = rawContractor; 
                }
                
                // --- ZONE 2: Dates (Placed exactly inside the day grid bounds) ---
                let attItems = uniqueLine.filter((u, idx) => idx > cEndIdx && u.x < globalRepX);
                let datesArray = new Array(31).fill('-'); // Will remain '-' if absent/missing punch
                
                if (globalDateBins[0] !== null) {
                    attItems.forEach(att => {
                        let closestIdx = -1;
                        let minDiff = 12; // Snap tolerance
                        for (let k = 0; k < 31; k++) {
                            if (globalDateBins[k] !== null) {
                                let diff = Math.abs(att.x - globalDateBins[k]);
                                if (diff < minDiff) {
                                    minDiff = diff;
                                    closestIdx = k;
                                }
                            }
                        }
                        if (closestIdx !== -1) {
                            datesArray[closestIdx] = att.text;
                        }
                    });
                } else {
                    // Fallback
                    for(let k = 0; k < attItems.length && k < 31; k++) {
                        datesArray[k] = attItems[k].text;
                    }
                }
                
                // --- ZONE 3: Supervisors (Strictly past Reporting boundaries) ---
                let supItems = uniqueLine.filter(u => u.x >= globalRepX);
                let tl = "N/A", sanctioner = "N/A";
                
                if (globalSancX !== 9999) {
                    let tlWords = supItems.filter(u => u.x < globalSancX).map(u => u.text);
                    let sancWords = supItems.filter(u => u.x >= globalSancX).map(u => u.text);
                    if (tlWords.length > 0) tl = tlWords.join(' ');
                    if (sancWords.length > 0) sanctioner = sancWords.join(' ');
                } else {
                    let supTexts = supItems.map(u => u.text);
                    if (supTexts.length >= 2) {
                        let half = Math.floor(supTexts.length / 2);
                        tl = supTexts.slice(0, half).join(' ');
                        sanctioner = supTexts.slice(half).join(' ');
                    } else if (supTexts.length === 1) {
                        tl = supTexts[0];
                    }
                }

                // Append finalized reliable employee record
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
