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

    // Global constraints maintained across pages
    let colBounds = { status: null, contractor: null, rep: null, sanc: null };
    let dateBins = {}; 

    // Set of valid attendance codes for Strict Matching
    const validAttSet = new Set(['p', 'mp', 'a', 'hd', 'wo', 'slwp', 'lvp', 'slp', 'pl', 'fd', 'l', 'ho', 'ho(rota)', 'wwo', 'cf', 'who', 'who(rota)']);

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

        // 2. DYNAMICALLY FIND HEADERS & DATE COLUMNS ON THIS PAGE
        let statusHead = items.find(itm => itm.text.toLowerCase().replace(/\s+/g, '') === 'status');
        if (statusHead) {
            let headersY = statusHead.y;
            let headerRowItems = items.filter(itm => Math.abs(itm.y - headersY) < 10);
            
            for (let item of headerRowItems) {
                let t = item.text.toLowerCase().replace(/\s+/g, '');
                if (t === 'status') colBounds.status = item.x;
                if (t === 'contractor') colBounds.contractor = item.x;
                if (t === 'reportingperson' || t.includes('reporting')) colBounds.rep = item.x;
                if (t === 'sanctioner') colBounds.sanc = item.x;
            }

            // Map Date headers dynamically based on what ACTUALLY exists (1, 2, 3...)
            dateBins = {};
            for (let item of headerRowItems) {
                let day = parseInt(item.text);
                if (!isNaN(day) && day >= 1 && day <= 31) {
                    if (colBounds.contractor && colBounds.rep) {
                        // Ensure it falls between Contractor and Reporting person
                        if (item.x > colBounds.contractor && item.x < colBounds.rep) {
                            dateBins[day] = item.x;
                        }
                    } else {
                        dateBins[day] = item.x;
                    }
                }
            }
        }

        // 3. GROUP BY Y COORDINATE
        let rows = [];
        items.forEach(item => {
            let foundRow = rows.find(r => Math.abs(r.y - item.y) < 8);
            if (foundRow) foundRow.items.push(item);
            else rows.push({ y: item.y, items: [item] });
        });

        // 4. PARSE ROWS
        for (let row of rows) {
            row.items.sort((a, b) => a.x - b.x); 
            
            let statusIdx = row.items.findIndex(i => i.text.toLowerCase() === 'active' || i.text.toLowerCase() === 'left');
            if (statusIdx === -1) continue; 

            let status = row.items[statusIdx].text;

            // Extract Code and Name perfectly
            let preStatusItems = row.items.slice(0, statusIdx);
            let preStatusText = preStatusItems.map(i => i.text).join(' ');
            let codeMatch = preStatusText.match(/([A-Z0-9]{2,6}\s*-\s*\d{3,8})/i);
            
            if (!codeMatch) continue; 
            
            let code = codeMatch[1].replace(/\s+/g, '');
            let name = preStatusText.substring(codeMatch.index + codeMatch[0].length).trim();
            name = name.replace(/^[-\s]+/, ''); // Clean leading hyphens

            let postStatus = row.items.slice(statusIdx + 1);

            // Merge "HO" and "(ROTA)" if they were split into two elements
            for (let j = 0; j < postStatus.length - 1; j++) {
                if (postStatus[j].text.trim().toUpperCase() === 'HO' && postStatus[j+1].text.trim().toUpperCase() === '(ROTA)') {
                    postStatus[j].text = 'HO (ROTA)';
                    postStatus.splice(j+1, 1);
                    j--;
                }
            }

            let contractorParts = [];
            let repParts = [];
            let sancParts = [];
            let datesMap = {};

            // Strictly route data pieces based on Coordinates and Validity
            for (let item of postStatus) {
                // Remove "(Pending)" variations safely for matching against valid att codes
                let tClean = item.text.toLowerCase().replace(/\s*\(pending\)/g, '').replace(/\s+/g, '');
                let isAttCode = validAttSet.has(tClean) || tClean === '-';

                let matchedAsDate = false;
                
                // If it looks like a valid code AND it lives geographically in the dates column section
                if (isAttCode && colBounds.contractor && colBounds.rep && item.x > colBounds.contractor + 10 && item.x < colBounds.rep - 10) {
                    let nearestDay = null;
                    let minDist = 999;
                    
                    // Route to the nearest actually existing day column
                    for (let day in dateBins) {
                        let dist = Math.abs(item.x - dateBins[day]);
                        if (dist < minDist) {
                            minDist = dist;
                            nearestDay = day;
                        }
                    }
                    if (nearestDay && minDist < 15) {
                        datesMap[nearestDay] = item.text;
                        matchedAsDate = true;
                    }
                }
                
                if (!matchedAsDate) {
                    if (colBounds.rep && item.x < colBounds.rep - 25) {
                        contractorParts.push(item.text);
                    } else if (colBounds.sanc && item.x >= colBounds.sanc - 20) {
                        sancParts.push(item.text);
                    } else {
                        repParts.push(item.text);
                    }
                }
            }

            // Clean Data
            let contractorRaw = contractorParts.join(' ');
            let contractor = cleanContractor(contractorRaw);
            
            let tl = repParts.join(' ').trim() || "N/A";
            let sanctioner = sancParts.join(' ').trim() || "N/A";

            // Fill standard 31-day array
            let datesArray = new Array(31).fill('-');
            for (let day in datesMap) {
                datesArray[parseInt(day) - 1] = datesMap[day];
            }

            if (name.length > 2) {
                globalData.push({ code, name, status, contractor, dates: datesArray, tl, sanctioner });
            }
        }
    }

    console.log(`✅ Successfully parsed ${globalData.length} employee records.`);
    fs.writeFileSync('data.json', JSON.stringify({ currentMonthStr, globalData })); // Outputs compressed payload
    console.log("🚀 Saved to data.json successfully!");
}

function cleanContractor(raw) {
    let cLow = raw.toLowerCase();
    if (cLow.includes('adecco')) return 'ADECCO';
    if (cLow.includes('ananya')) return 'ANANYA';
    if (cLow.includes('dibya')) return 'Dibya Industrial Service';
    if (cLow.includes('esjay')) return 'ESJAY';
    if (cLow.includes('mathew')) return 'MATHEW';
    if (cLow.includes('om sai')) return 'Om Sai Krupa Enterprise';
    if (cLow.includes('sham')) return 'SHAM';
    if (cLow.includes('vasudeva')) return 'VASUDEVA';
    if (cLow.includes('yashaswi')) return 'YASHASWI';
    return raw.trim() || "Unknown";
}

fetchAndParsePDF().catch(err => { 
    console.error("❌ Fatal Error:", err.message);
    process.exit(1); 
});
