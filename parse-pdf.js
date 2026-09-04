const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const GAS_URL = "https://script.google.com/macros/s/AKfycbzBMx-fZAifindtXbsXVueYEYQz4uBT1cA8CnlrZH3MTHEyR4RMv6uxaPhdKwskiP4T/exec";

async function fetchAndParsePDF() {
    console.log("🌐 Fetching PDF from Google Apps Script...");
    const response = await fetch(GAS_URL);
    if (!response.ok) throw new Error("Network response was not ok");

    const json = await response.json();
    if (!json.success) throw new Error("GAS Error: " + json.error);

    console.log(`📄 Received PDF: ${json.fileNameUsed || "Unknown Name"}`);
    
    console.log("📦 Decoding Base64 PDF data...");
    const pdfBuffer = Buffer.from(json.data, 'base64');
    const pdfData = new Uint8Array(pdfBuffer);

    console.log("⚙️ Parsing PDF with pdf.js...");
    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    console.log(`📑 Total Pages Found in PDF: ${pdf.numPages}`);

    let globalData = [];
    let currentMonthStr = "Unknown Month";
    let maxDays = 31; // Default fallback
    let foundMaxDays = false;

    const validAttSet = new Set(['p', 'mp', 'a', 'hd', 'wo', 'slwp', 'lvp', 'slp', 'pl', 'fd', 'l', 'ho', 'wwo', 'cf', 'who', 'ho(rota)', 'who(rota)', '-', '--', 'co', 'u/a', 'w/o']);

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        // Extract items with width to calculate physical gaps later
        let items = textContent.items
            .map(item => ({ 
                text: item.str, 
                x: item.transform[4], 
                y: item.transform[5],
                width: item.width || (item.str.length * 5) // Fallback if width is missing
            }))
            .filter(item => item.text.trim() !== '');

        if (items.length === 0) continue;

        // 1. GROUP BY Y COORDINATE to form lines
        let rows = [];
        items.forEach(item => {
            let foundRow = rows.find(r => Math.abs(r.y - item.y) < 10);
            if (foundRow) foundRow.items.push(item);
            else rows.push({ y: item.y, items: [item] });
        });

        // 2. RECONSTRUCT LINES ACCURATELY USING GAP DETECTION
        for (let row of rows) {
            row.items.sort((a, b) => a.x - b.x); 
            
            let fullText = "";
            let prev = null;
            
            for (let itm of row.items) {
                if (prev) {
                    // Calculate distance between the end of the previous item and the start of this one
                    let gap = itm.x - (prev.x + prev.width);
                    // If the gap is larger than 4 pixels, it's a real space. Otherwise, merge them!
                    if (gap > 4) fullText += " ";
                }
                fullText += itm.text;
                prev = itm;
            }
            
            // Clean up text format
            fullText = fullText.replace(/\s+/g, ' ').trim();
            fullText = fullText.replace(/-\s+-/g, '--'); // Fix separated dashes for Left employees
            fullText = fullText.replace(/HO\s*\(ROTA\)/gi, 'HO(ROTA)').replace(/WHO\s*\(ROTA\)/gi, 'WHO(ROTA)');

            // Extract Month
            if (currentMonthStr === "Unknown Month") {
                let monthMatch = fullText.match(/Month\s*of\s*([A-Za-z]+)\s*(\d{4})/i) || fullText.replace(/\s/g, '').match(/Monthof([A-Za-z]+)(\d{4})/i);
                if (monthMatch) currentMonthStr = monthMatch[1] + " " + monthMatch[2];
            }

            // Detect how many day columns exist in this specific PDF (e.g. 1 2)
            if (!foundMaxDays) {
                let headerMatch = fullText.match(/Contractor\s+((?:\d{1,2}\s*)+)Reporting/i);
                if (headerMatch) {
                    let daysArr = headerMatch[1].trim().split(/\s+/).map(Number);
                    if (daysArr.length > 0) {
                        maxDays = Math.max(...daysArr);
                        foundMaxDays = true;
                        console.log(`📅 Detected dynamic days in this report: ${maxDays} Days`);
                    }
                }
            }

            // 3. REGEX TO MATCH EMPLOYEE ROWS 
            // Looks for: (Code) (Name) (Active/Left) (Rest of string)
            let regex = /^([A-Z0-9]+\s*-\s*\d+)\s+(.+?)\s+(Active|Left)\s+(.+)$/i;
            let match = fullText.match(regex);

            if (!match) continue; 

            let code = match[1].replace(/\s+/g, ''); // Ensure no spaces in AD-1234
            let name = match[2].trim();
            let status = match[3];
            let remainder = match[4].trim();

            // 4. EXTRACT CONTRACTOR
            // Sorted longest to shortest to prevent partial matches
            let knownContractors = ['Dibya Industrial Service', 'Om Sai Krupa Enterprise', 'Om Sai Krupa', 'YASHASWI', 'VASUDEVA', 'ANANYA', 'ADECCO', 'MATHEW', 'Dibya', 'ESJAY', 'Om Sai', 'SHAM'];
            let contractor = 'Unknown';
            
            for (let c of knownContractors) {
                if (remainder.toLowerCase().startsWith(c.toLowerCase())) {
                    contractor = c;
                    remainder = remainder.substring(c.length).trim();
                    break;
                }
            }
            
            if (contractor === 'Unknown') {
                let parts = remainder.split(/\s+/);
                contractor = parts[0];
                remainder = parts.slice(1).join(' ').trim();
            }

            // 5. EXTRACT ATTENDANCE & SUPERVISORS
            let tokens = remainder.split(/\s+/);
            let datesArray = new Array(31).fill('-');
            let datePointer = 0;
            let supTokens = [];
            let parsingDates = true;

            for (let token of tokens) {
                let tClean = token.toLowerCase();
                
                if (parsingDates) {
                    // Stop checking for dates if we've processed all available day columns for this month
                    if (datePointer >= maxDays) {
                        parsingDates = false;
                        supTokens.push(token);
                    } else if (validAttSet.has(tClean)) {
                        datesArray[datePointer] = token.toUpperCase() === 'HO(ROTA)' ? 'HO (ROTA)' : token.toUpperCase();
                        datePointer++;
                    } else if (/^\d{1,2}$/.test(token)) {
                        continue; // Stray header numbers bleeding into row
                    } else {
                        // Reached supervisors text
                        parsingDates = false;
                        supTokens.push(token);
                    }
                } else {
                    supTokens.push(token);
                }
            }

            // 6. SPLIT SUPERVISORS (TL & Sanctioner)
            let tl = "N/A", sanctioner = "N/A";
            if (supTokens.length > 0) {
                let mid = Math.floor(supTokens.length / 2);
                if (mid === 0) {
                    tl = supTokens[0];
                    sanctioner = supTokens[0];
                } else {
                    tl = supTokens.slice(0, mid).join(' ');
                    sanctioner = supTokens.slice(mid).join(' ');
                }
            }

            if (name.length > 2) {
                globalData.push({ code, name, status, contractor, dates: datesArray, tl, sanctioner });
            }
        }
    }

    console.log(`✅ Successfully parsed ${globalData.length} employee records.`);
    
    if (globalData.length === 0) {
        console.log("⚠️ WARNING: 0 records found. The regex didn't match any rows.");
    }

    fs.writeFileSync('data.json', JSON.stringify({ currentMonthStr, globalData }));
    console.log("🚀 Saved to data.json successfully!");
}

fetchAndParsePDF().catch(err => { 
    console.error("❌ Fatal Error:", err.message);
    process.exit(1); 
});
