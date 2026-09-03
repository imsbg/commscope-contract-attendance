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

    // Global Grids
    let dateBins = new Array(31).fill(null);
    let repX = 9999; 
    let sancX = 9999;

    const attCodes = new Set(['p', 'a', 'wo', 'hd', 'fd', 'slwp', 'lwp', 'mp', 'l', '-', '--', 'ho', 'rota', 'ho(rota)', 'pl', 'wwo', 'cf', 'who', 'who(rota)']);

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        let items = textContent.items
            .map(item => ({ text: item.str.trim(), x: item.transform[4], y: item.transform[5] }))
            .filter(item => item.text !== '');

        if (items.length === 0) continue;

        // 1. EXTRACT MONTH
        if (currentMonthStr === "Unknown Month") {
            let fullText = items.map(i => i.text).join(' ');
            let match = fullText.match(/Month\s*of\s*([A-Za-z]+)\s*(\d{4})/i) || fullText.replace(/\s/g, '').match(/Monthof([A-Za-z]+)(\d{4})/i);
            if (match) currentMonthStr = match[1] + " " + match[2];
        }

        // 2. FIND COLUMNS X-COORDINATES
        let contractorHead = items.find(itm => itm.text.toLowerCase().includes('contractor'));
        let reportingHead = items.find(itm => itm.text.toLowerCase().includes('reporting'));
        let sancHead = items.find(itm => itm.text.toLowerCase().includes('sanctioner'));
        
        if (reportingHead) repX = reportingHead.x;
        if (sancHead) sancX = sancHead.x;

        if (contractorHead && dateBins[0] === null) {
            let headerY = contractorHead.y;
            let dayHeaders = items.filter(itm => Math.abs(itm.y - headerY) < 10 && /^\d{1,2}$/.test(itm.text));
            
            dayHeaders.forEach(h => {
                let d = parseInt(h.text);
                if (d >= 1 && d <= 31) dateBins[d - 1] = h.x;
            });

            // Extrapolate missing columns
            for (let k = 30; k >= 0; k--) {
                if (dateBins[k] !== null) {
                    for (let j = k - 1; j >= 0; j--) {
                        if (dateBins[j] === null) dateBins[j] = dateBins[j+1] - 18.5;
                    }
                    for (let j = k + 1; j < 31; j++) {
                        if (dateBins[j] === null) dateBins[j] = dateBins[j-1] + 18.5;
                    }
                    break;
                }
            }
        }

        // 3. GROUP BY Y COORDINATE (Binds shattered rows together)
        let rows = [];
        items.forEach(item => {
            let foundRow = rows.find(r => Math.abs(r.y - item.y) < 8);
            if (foundRow) foundRow.items.push(item);
            else rows.push({ y: item.y, items: [item] });
        });

        // 4. PARSE ROWS
        for (let row of rows) {
            row.items.sort((a, b) => a.x - b.x); 
            
            // Re-bind HO (ROTA) if split
            for (let j = 0; j < row.items.length; j++) {
                if (row.items[j].text.trim() === 'HO' && row.items[j+1] && row.items[j+1].text.trim() === '(ROTA)') {
                    row.items[j].text = 'HO (ROTA)';
                    row.items.splice(j+1, 1);
                    j--;
                }
            }

            let statusIdx = row.items.findIndex(i => i.text.toLowerCase() === 'active' || i.text.toLowerCase() === 'left');
            if (statusIdx === -1) continue; 

            let status = row.items[statusIdx].text;

            // Extract Code and Name perfectly
            let preStatusText = row.items.slice(0, statusIdx).map(i => i.text).join(' ');
            let codeMatch = preStatusText.match(/([A-Z0-9]{2,6}\s*-\s*\d{3,8})/i);
            
            if (!codeMatch) continue; // Not an employee row
            
            let code = codeMatch[1].replace(/\s+/g, '');
            let name = preStatusText.substring(codeMatch.index + codeMatch[0].length).trim();
            name = name.replace(/^[-\s]+/, ''); // Clean leading hyphens

            // Categorize the rest of the row
            let contractorItems = [];
            let attItems = [];
            let supItems = [];
            let contractorEnd = false;

            for (let j = statusIdx + 1; j < row.items.length; j++) {
                let item = row.items[j];
                let tLow = item.text.toLowerCase().replace(/\s*\(pending\)/g, '').replace(/\s+/g, '');
                let isAttCode = attCodes.has(tLow) || tLow === 'ho(rota)';

                if (!contractorEnd) {
                    if (isAttCode || /^\d{1,2}$/.test(tLow) || item.x >= repX - 30) {
                        contractorEnd = true;
                    } else {
                        contractorItems.push(item);
                        continue;
                    }
                }

                // Post-Contractor separation
                if (item.x >= repX - 30) {
                    supItems.push(item);
                } else if (isAttCode) {
                    item.cleanVal = tLow === 'ho(rota)' ? 'HO (ROTA)' : item.text.trim();
                    attItems.push(item);
                } else if (!/^\d{1,2}$/.test(tLow)) {
                    supItems.push(item); // Fallback for supervisors if columns shifted
                }
            }

            // Clean Contractor
            let contractorRaw = contractorItems.map(i => i.text).join(' ');
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

            // Map Attendance to 31-Day Grid
            let datesArray = new Array(31).fill('-');
            attItems.forEach(att => {
                let closestIdx = -1;
                let minDiff = 14; 
                
                if (dateBins[0] !== null) {
                    for (let k = 0; k < 31; k++) {
                        if (dateBins[k] !== null && Math.abs(att.x - dateBins[k]) < minDiff) {
                            minDiff = Math.abs(att.x - dateBins[k]);
                            closestIdx = k;
                        }
                    }
                }
                
                if (closestIdx !== -1) {
                    datesArray[closestIdx] = att.cleanVal;
                } else {
                    // Emergency fallback: push to first empty slot
                    let emptySlot = datesArray.indexOf('-');
                    if (emptySlot !== -1) datesArray[emptySlot] = att.cleanVal;
                }
            });

            // Clean Supervisors
            let tl = "N/A", sanctioner = "N/A";
            if (sancX !== 9999) {
                let tlArr = supItems.filter(u => u.x < sancX - 15).map(u => u.text);
                let sancArr = supItems.filter(u => u.x >= sancX - 15).map(u => u.text);
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
