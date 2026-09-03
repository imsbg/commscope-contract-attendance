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

    // Track grid boundaries globally
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

        // 1. EXTRACT MONTH (Bulletproofed for missing spaces)
        let joinedNoSpace = items.map(itm => itm.text).join('');
        let joinedSpace = items.map(itm => itm.text).join(' ');
        
        let monthMatch = joinedNoSpace.match(/Monthof([A-Za-z]+)(\d{4})/i) || joinedSpace.match(/Month\s*of\s*([A-Za-z]+)\s*(\d{4})/i);
        if (monthMatch && currentMonthStr === "Unknown Month") {
            currentMonthStr = monthMatch[1] + " " + monthMatch[2]; // E.g. "September 2026"
        }

        // 2. DETECT COLUMN ZONES & EXTRAPOLATE CALENDAR GRID
        let contractorHeader = items.find(itm => itm.text.toLowerCase() === 'contractor');
        let repHeader = items.find(itm => itm.text.toLowerCase().includes('reporting'));
        let sancHeader = items.find(itm => itm.text.toLowerCase().includes('sanctioner'));
        
        let headerRowY = contractorHeader ? contractorHeader.y : (repHeader ? repHeader.y : null);

        if (repHeader) globalRepX = repHeader.x - 15;
        if (sancHeader) globalSancX = sancHeader.x - 15;

        // If we found the header row and haven't built the grid yet
        if (headerRowY !== null && globalDateBins[0] === null) {
            let dayHeaders = items.filter(itm => 
                Math.abs(itm.y - headerRowY) < 10 && 
                /^\d{1,2}$/.test(itm.text)
            );

            if (dayHeaders.length > 0) {
                let localDateBins = new Array(31).fill(null);
                dayHeaders.forEach(h => {
                    let day = parseInt(h.text);
                    if (day >= 1 && day <= 31) localDateBins[day - 1] = h.x;
                });

                // Dynamically find gap between days (default 18px)
                let gap = 18; 
                dayHeaders.sort((a,b) => a.x - b.x);
                let gaps = [];
                for(let k = 1; k < dayHeaders.length; k++) {
                    let d = dayHeaders[k].x - dayHeaders[k-1].x;
                    if (d > 5 && d < 40) gaps.push(d); 
                }
                if (gaps.length > 0) {
                    gaps.sort((a,b) => a - b);
                    gap = gaps[Math.floor(gaps.length / 2)];
                }

                // Extrapolate missing days
                for (let k = 30; k >= 0; k--) {
                    if (localDateBins[k] !== null) {
                        for (let j = k - 1; j >= 0; j--) {
                            if (localDateBins[j] === null) localDateBins[j] = localDateBins[j+1] - gap;
                        }
                        for (let j = k + 1; j < 31; j++) {
                            if (localDateBins[j] === null) localDateBins[j] = localDateBins[j-1] + gap;
                        }
                        break; 
                    }
                }
                globalDateBins = localDateBins; // Lock in the grid
            }
        }

        // 3. LASER SORTING (Group perfectly by Y-Coordinate Rows)
        items.sort((a, b) => {
            if (Math.abs(b.y - a.y) > 4) return b.y - a.y; // Top to bottom
            return a.x - b.x; // Left to right
        });

        let lines = [];
        let currentRow = [];
        let lastY = -1000;

        for (let item of items) {
            if (Math.abs(item.y - lastY) > 4) {
                if (currentRow.length > 0) lines.push(currentRow);
                currentRow = [item];
                lastY = item.y;
            } else {
                currentRow.push(item);
            }
        }
        if (currentRow.length > 0) lines.push(currentRow);

        // 4. PROCESS EACH ROW
        for (let line of lines) {
            line.sort((a,b) => a.x - b.x);
            
            // Remove exact duplicates
            let uniqueLine = [];
            for (let item of line) {
                if (!uniqueLine.some(u => u.text === item.text && Math.abs(u.x - item.x) < 5)) {
                    uniqueLine.push(item);
                }
            }

            let textArray = uniqueLine.map(u => u.text);
            let fullText = textArray.join(' ');

            // DOES THIS ROW LOOK LIKE AN EMPLOYEE RECORD?
            // (Even if 'AD', '-', and '12345' are separated by spaces, this catches it)
            let codeMatch = fullText.match(/^([A-Z0-9]{2,6}\s*-?\s*\d{3,8})/i);
            let statusIdx = uniqueLine.findIndex(u => u.text.toLowerCase() === 'active' || u.text.toLowerCase() === 'left');

            // If we found an employee ID and a Status in the row
            if (codeMatch && statusIdx > 0) {
                let code = codeMatch[1].replace(/\s+/g, ''); // Fix split hyphens (e.g. AD-12744)
                
                // Name is everything between Code and Status
                let nameArr = textArray.slice(0, statusIdx);
                let nameStr = nameArr.join(' ').substring(codeMatch[1].length).trim();
                let name = nameStr.replace(/^[-\s]+/, ''); // Strip trailing hyphens/spaces

                let status = textArray[statusIdx];

                // Find Contractor
                let contractor = "Unknown";
                let cEndIdx = statusIdx;
                for (let j = statusIdx + 1; j < uniqueLine.length; j++) {
                    let wLower = uniqueLine[j].text.toLowerCase();
                    // Stop if we hit an attendance code, a day number, or cross into Supervisors
                    if (attCodes.has(wLower) || /^\d+$/.test(wLower) || uniqueLine[j].x > (globalRepX - 30)) {
                        break;
                    }
                    cEndIdx = j;
                }

                if (cEndIdx > statusIdx) {
                    let rawContractor = textArray.slice(statusIdx + 1, cEndIdx + 1).join(' ');
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

                // Filter Attendance Items vs Supervisor Names
                let attItems = [];
                let supItems = [];
                
                for (let j = cEndIdx + 1; j < uniqueLine.length; j++) {
                    let tLow = uniqueLine[j].text.toLowerCase().replace(/\s*\(pending\)/g, '');
                    if (attCodes.has(tLow)) {
                        attItems.push(uniqueLine[j]);
                    } else if (!/^\d{1,2}$/.test(tLow)) { // Ignore random floating day numbers
                        supItems.push(uniqueLine[j]);
                    }
                }

                // Map Attendance into strict Calendar Grid
                let datesArray = new Array(31).fill('-');
                if (globalDateBins[0] !== null) {
                    attItems.forEach(att => {
                        let closestIdx = -1;
                        let minDiff = 15; // Max horizontal drift to accept
                        for (let k = 0; k < 31; k++) {
                            if (globalDateBins[k] !== null) {
                                let diff = Math.abs(att.x - globalDateBins[k]);
                                if (diff < minDiff) {
                                    minDiff = diff;
                                    closestIdx = k;
                                }
                            }
                        }
                        if (closestIdx !== -1) datesArray[closestIdx] = att.text;
                    });
                } else {
                    for(let k = 0; k < attItems.length && k < 31; k++) datesArray[k] = attItems[k].text;
                }

                // Map Supervisors
                let tl = "N/A", sanctioner = "N/A";
                if (globalRepX !== 9999) {
                    let tlWords = supItems.filter(u => u.x < (globalSancX !== 9999 ? globalSancX : 9999)).map(u => u.text);
                    let sancWords = supItems.filter(u => u.x >= globalSancX).map(u => u.text);
                    if (tlWords.length > 0) tl = tlWords.join(' ');
                    if (sancWords.length > 0) sanctioner = sancWords.join(' ');
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
    }

    console.log(`✅ Successfully parsed ${globalData.length} employee records.`);
    fs.writeFileSync('data.json', JSON.stringify({ currentMonthStr, globalData }));
    console.log("🚀 Saved to data.json successfully!");
}

fetchAndParsePDF().catch(err => { 
    console.error("❌ Fatal Error:", err.message);
    process.exit(1); 
});
