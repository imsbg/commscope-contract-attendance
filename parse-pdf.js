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

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        let items = textContent.items
            .map(item => ({ text: item.str.trim(), x: item.transform[4], y: item.transform[5] }))
            .filter(item => item.text !== '');

        // 1. EXTRACT MONTH
        let fullPageText = items.map(i => i.text).join(' ');
        const monthMatch = fullPageText.match(/Attendance for the Month of\s*([A-Za-z]+\s*\d{4})/i);
        if (monthMatch && currentMonthStr === "Unknown Month") {
            currentMonthStr = monthMatch[1];
        }

        // 2. DETECT COLUMN X-COORDINATES FOR DATES (1 to 31)
        let dateBins = new Array(31).fill(null);
        let possibleHeaders = items.filter(i => /^\d{1,2}$/.test(i.text) && parseInt(i.text) >= 1 && parseInt(i.text) <= 31);
        let headerYs = {};
        
        // Group items by Y coordinate (nearest 5px to account for slight misalignment)
        possibleHeaders.forEach(h => {
            let key = Math.round(h.y / 5) * 5;
            if(!headerYs[key]) headerYs[key] = [];
            headerYs[key].push(h);
        });
        
        // Find the row containing the most numbers (the header row)
        let bestY = Object.keys(headerYs).sort((a,b) => headerYs[b].length - headerYs[a].length)[0];
        if (bestY && headerYs[bestY].length >= 25) {
            let headers = headerYs[bestY].sort((a,b) => a.x - b.x);
            headers.forEach(h => {
                let day = parseInt(h.text);
                if(day >= 1 && day <= 31) dateBins[day - 1] = h.x;
            });
            
            // Interpolate missing columns just in case a number didn't parse
            for(let k = 0; k < 31; k++) {
                if(dateBins[k] === null && k > 0 && dateBins[k-1] !== null) {
                    dateBins[k] = dateBins[k-1] + 18; // approx distance between columns
                }
            }
        }

        // 3. STABLE 2D SORT
        items.sort((a, b) => {
            if (Math.abs(b.y - a.y) > 3) return b.y - a.y; 
            return a.x - b.x; 
        });

        // 4. ANCHOR GROUPING (Splits rows on Employee Code)
        let lines = [];
        let currentRow = [];

        for (let item of items) {
            let t = item.text.toLowerCase();
            if (t === 'page' || t === 'of') continue; // Skip footers
            
            const isEmployeeCode = /^[A-Z0-9]{2,6}-\d{3,8}$/i.test(item.text) && item.x < 150;

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

        // 5. PROCESS EACH ROW
        for (let line of lines) {
            line.sort((a, b) => a.x - b.x);

            let uniqueLine = [];
            for (let item of line) {
                let isDuplicate = uniqueLine.some(u => u.text === item.text && Math.abs(u.x - item.x) < 12);
                if (!isDuplicate) uniqueLine.push(item);
            }

            // Clean up text but retain objects
            for (let j = 0; j < uniqueLine.length; j++) {
                uniqueLine[j].text = uniqueLine[j].text.replace(/\s*\(Pending\)/ig, '').trim();
                if (uniqueLine[j].text === 'HO' && uniqueLine[j+1] && uniqueLine[j+1].text === '(ROTA)') {
                    uniqueLine[j].text = 'HO (ROTA)';
                    uniqueLine.splice(j+1, 1);
                    j--;
                }
            }

            let sortedTexts = uniqueLine.map(u => u.text);
            let statusIdx = sortedTexts.findIndex(str => str.toLowerCase() === 'active' || str.toLowerCase() === 'left');
            
            if (statusIdx >= 1 && uniqueLine.length >= 6) {
                let code = sortedTexts[0];
                let name = sortedTexts.slice(1, statusIdx).join(' ');
                let status = sortedTexts[statusIdx];
                
                // Remove duplicate Statuses
                for(let j = statusIdx + 1; j < uniqueLine.length; j++) {
                    let t = uniqueLine[j].text.toLowerCase();
                    if (t === 'active' || t === 'left') {
                        uniqueLine.splice(j, 1);
                        sortedTexts.splice(j, 1);
                        j--; 
                    }
                }
                
                const attCodes = new Set(['p', 'a', 'wo', 'hd', 'fd', 'slwp', 'lwp', 'mp', 'l', '-', '--', 'ho', 'rota', 'ho (rota)']);
                
                let firstDateIdx = -1;
                for(let j = statusIdx + 1; j < sortedTexts.length; j++) {
                    if (attCodes.has(sortedTexts[j].toLowerCase())) {
                        firstDateIdx = j; break;
                    }
                }

                if (firstDateIdx !== -1) {
                    let rawContractor = sortedTexts.slice(statusIdx + 1, firstDateIdx).join(' ');
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

                    let lastDateIdx = firstDateIdx;
                    while (lastDateIdx < sortedTexts.length && attCodes.has(sortedTexts[lastDateIdx].toLowerCase())) {
                        lastDateIdx++;
                    }
                    lastDateIdx--;

                    // ⭐ SMART DATE MAPPING ALGORITHM ⭐
                    let attItems = uniqueLine.slice(firstDateIdx, lastDateIdx + 1);
                    let datesArray = new Array(31).fill('-'); // Initialize all 31 days with blanks
                    
                    if (dateBins[0] !== null) { // If column coordinates were found
                        attItems.forEach(att => {
                            let closestIdx = -1;
                            let minDiff = 12; // Max horizontal variance to accept
                            
                            for(let k = 0; k < 31; k++) {
                                if (dateBins[k] !== null) {
                                    let diff = Math.abs(att.x - dateBins[k]);
                                    if(diff < minDiff) {
                                        minDiff = diff;
                                        closestIdx = k;
                                    }
                                }
                            }
                            // Assign status accurately to its physical column
                            if (closestIdx !== -1) {
                                datesArray[closestIdx] = att.text;
                            }
                        });
                    } else {
                        // Fallback logic if pdf format strictly fails
                        for(let k = 0; k < attItems.length && k < 31; k++) {
                            datesArray[k] = attItems[k].text;
                        }
                    }

                    let remainingWords = sortedTexts.slice(lastDateIdx + 1);
                    let tl = "N/A", sanctioner = "N/A";
                    
                    if (remainingWords.length >= 2) {
                        if (remainingWords.length === 2) {
                            tl = remainingWords[0]; sanctioner = remainingWords[1];
                        } else {
                            let half = Math.floor(remainingWords.length / 2);
                            tl = remainingWords.slice(0, half).join(' ');
                            sanctioner = remainingWords.slice(half).join(' ');
                        }
                    } else if (remainingWords.length === 1) {
                        tl = remainingWords[0];
                    }

                    if (code.length > 2 && name.length > 2) {
                        globalData.push({ code, name, status, contractor, dates: datesArray, tl, sanctioner });
                    }
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
