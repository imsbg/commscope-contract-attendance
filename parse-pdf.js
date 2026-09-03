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
        let fullPageNoSpace = items.map(itm => itm.text).join('');
        
        let m1 = fullPageText.match(/Month\s*of\s*([A-Za-z]+)\s*(\d{4})/i);
        let m2 = fullPageNoSpace.match(/Monthof([A-Za-z]+)(\d{4})/i);
        
        if (currentMonthStr === "Unknown Month") {
            if (m1) currentMonthStr = m1[1] + " " + m1[2];
            else if (m2) currentMonthStr = m2[1] + " " + m2[2];
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
                
                // Assign known headers
                dayHeaders.forEach(h => {
                    let day = parseInt(h.text);
                    if (day >= 1 && day <= 31) globalDateBins[day - 1] = h.x;
                });

                // Calculate average gap
                let gap = 18.5; // Default safe fallback
                let gaps = [];
                for(let k = 1; k < dayHeaders.length; k++) {
                    let d = dayHeaders[k].x - dayHeaders[k-1].x;
                    if (d > 5 && d < 35) gaps.push(d); 
                }
                if (gaps.length > 0) {
                    gaps.sort((a,b) => a - b);
                    gap = gaps[Math.floor(gaps.length / 2)]; 
                }

                // Fill missing slots left and right
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

        // 4. GROUP BY Y-COORDINATES (The ultimate row binder)
        let yBins = [];
        for (let item of items) {
            let placed = false;
            for (let bin of yBins) {
                // A very generous 12px tolerance bounds fragmented text back into a single row
                if (Math.abs(bin.y - item.y) <= 12) { 
                    bin.items.push(item);
                    placed = true;
                    break;
                }
            }
            if (!placed) yBins.push({ y: item.y, items: [item] });
        }

        let lines = yBins.map(bin => {
            bin.items.sort((a, b) => a.x - b.x);
            return bin.items;
        });

        // 5. EXTRACT DATA PER ROW
        for (let line of lines) {
            // Pre-process HO (ROTA) splits
            for (let j = 0; j < line.length; j++) {
                if (line[j].text.trim() === 'HO' && line[j+1] && line[j+1].text.trim() === '(ROTA)') {
                    line[j].text = 'HO (ROTA)';
                    line.splice(j+1, 1);
                    j--;
                }
            }

            let textArr = line.map(u => u.text);
            let noSpaceText = textArr.join('').replace(/\s+/g, '');

            // Identify if it's an employee row using a space-insensitive check
            let codeMatch = noSpaceText.match(/([A-Z0-9]{2,6}-\d{3,8})/i);
            if (!codeMatch) continue;
            
            let code = codeMatch[1];

            // Find Status searching backwards (prevents matching someone named "Active")
            let statusIdx = -1;
            for (let j = line.length - 1; j >= 0; j--) {
                let t = line[j].text.toLowerCase();
                if (t === 'active' || t === 'left') {
                    statusIdx = j;
                    break;
                }
            }
            if (statusIdx === -1) continue;

            let status = line[statusIdx].text;

            // Extract Name safely
            let preStatusText = textArr.slice(0, statusIdx).join(' ');
            let escapedCode = code.replace('-', '\\s*-\\s*'); // Regex to catch fragmented codes
            let name = preStatusText.replace(new RegExp(escapedCode, 'i'), '').trim();
            name = name.replace(/^[-\s]+/, ''); // Clean leading hyphens

            // Extract Contractor
            let contractor = "Unknown";
            let cEndIdx = statusIdx;
            for (let j = statusIdx + 1; j < line.length; j++) {
                let tLower = line[j].text.toLowerCase().replace(/\s+/g, '');
                // Stop on attendance code, day number, or crossing into reporting person column
                if (attCodes.has(tLower) || /^\d{1,2}$/.test(tLower) || line[j].x > (globalRepX - 30)) {
                    break;
                }
                cEndIdx = j;
            }

            if (cEndIdx > statusIdx) {
                let rawContractor = textArr.slice(statusIdx + 1, cEndIdx + 1).join(' ');
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

            // Gather Attendance and Supervisors
            let attItems = [];
            let supItems = [];
            for (let j = cEndIdx + 1; j < line.length; j++) {
                let rawText = line[j].text;
                let cleanText = rawText.toLowerCase().replace(/\s*\(pending\)/g, '').replace(/\s+/g, '');
                
                if (line[j].x < (globalRepX - 25)) {
                    if (attCodes.has(cleanText)) {
                        line[j].cleanVal = cleanText === 'ho(rota)' ? 'HO (ROTA)' : rawText.trim();
                        attItems.push(line[j]);
                    }
                } else {
                    supItems.push(line[j]);
                }
            }

            // Map Dates to 31 Grid magnetically 
            let datesArray = new Array(31).fill('-');
            if (globalDateBins[0] !== null) {
                attItems.forEach(att => {
                    let closestIdx = -1;
                    let minDiff = 16; 
                    for (let k = 0; k < 31; k++) {
                        if (globalDateBins[k] !== null) {
                            let diff = Math.abs(att.x - globalDateBins[k]);
                            if (diff < minDiff) {
                                minDiff = diff;
                                closestIdx = k;
                            }
                        }
                    }
                    if (closestIdx !== -1) datesArray[closestIdx] = att.cleanVal;
                });
            } else {
                for(let k = 0; k < attItems.length && k < 31; k++) datesArray[k] = attItems[k].cleanVal;
            }

            // Map Supervisors
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

    console.log(`✅ Successfully parsed ${globalData.length} employee records.`);
    fs.writeFileSync('data.json', JSON.stringify({ currentMonthStr, globalData }));
    console.log("🚀 Saved to data.json successfully!");
}

fetchAndParsePDF().catch(err => { 
    console.error("❌ Fatal Error:", err.message);
    process.exit(1); 
});
