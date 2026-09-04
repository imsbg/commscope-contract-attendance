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
    if (json.fileUrl) console.log(`🔗 File Link: ${json.fileUrl}`);

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

    // Expanded valid attendance codes to include '--' (used for Left/Inactive employees) and other edge cases
    const validAttSet = new Set(['p', 'mp', 'a', 'hd', 'wo', 'slwp', 'lvp', 'slp', 'pl', 'fd', 'l', 'ho', 'wwo', 'cf', 'who', 'ho(rota)', 'who(rota)', '-', '--', 'co', 'u/a', 'w/o']);

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        let items = textContent.items
            .map(item => ({ text: item.str.trim(), x: item.transform[4], y: item.transform[5] }))
            .filter(item => item.text !== '');

        if (items.length === 0) continue;

        let fullTextPage = items.map(itm => itm.text).join(' ');

        // 1. EXTRACT MONTH
        if (currentMonthStr === "Unknown Month") {
            let match = fullTextPage.match(/Month\s*of\s*([A-Za-z]+)\s*(\d{4})/i) || fullTextPage.replace(/\s/g, '').match(/Monthof([A-Za-z]+)(\d{4})/i);
            if (match) currentMonthStr = match[1] + " " + match[2];
        }

        // Detect the exact number of days exported in this PDF from the table header
        // Matches "Contractor 1 2 ... Reporting"
        if (!foundMaxDays) {
            let headerMatch = fullTextPage.match(/Contractor\s+((?:\d{1,2}\s*)+)Reporting/i);
            if (headerMatch) {
                let daysArr = headerMatch[1].trim().split(/\s+/).map(Number);
                if (daysArr.length > 0) {
                    maxDays = Math.max(...daysArr);
                    foundMaxDays = true;
                    console.log(`📅 Detected dynamic days in this report: ${maxDays} Days`);
                }
            }
        }

        // 2. GROUP BY Y COORDINATE (Tolerance 10 to catch slight misalignments)
        let rows = [];
        items.forEach(item => {
            let foundRow = rows.find(r => Math.abs(r.y - item.y) < 10);
            if (foundRow) foundRow.items.push(item);
            else rows.push({ y: item.y, items: [item] });
        });

        // 3. PARSE ROWS via String Matching (Reads left to right)
        for (let row of rows) {
            row.items.sort((a, b) => a.x - b.x); 
            
            // Build full row string
            let fullText = row.items.map(itm => itm.text.trim()).filter(t => t).join(' ');
            
            // Pre-process known multi-word attendance codes so they don't break tokenizing
            fullText = fullText.replace(/HO\s*\(ROTA\)/gi, 'HO(ROTA)').replace(/WHO\s*\(ROTA\)/gi, 'WHO(ROTA)');

            // Regex looks for: (Letters-Numbers) (Name) (Active or Left)
            let regex = /([A-Z0-9]+[-\s]+\d+)\s+(.+?)\s+(Active|Left)\s+/i;
            let match = fullText.match(regex);

            if (!match) continue; // Skip if it doesn't look like an employee row

            let code = match[1].replace(/\s+/g, ''); // Ensure no spaces in code (e.g. AD-123)
            let name = match[2].trim();
            let status = match[3];

            // Everything after 'Active' / 'Left'
            let remainder = fullText.substring(match.index + match[0].length).trim();

            // 4. Extract Contractor
            let knownContractors = ['ADECCO', 'ANANYA', 'Dibya Industrial Service', 'Dibya', 'ESJAY', 'MATHEW', 'Om Sai Krupa Enterprise', 'Om Sai', 'SHAM', 'VASUDEVA', 'YASHASWI'];
            let contractor = 'Unknown';
            
            for (let c of knownContractors) {
                if (remainder.toLowerCase().startsWith(c.toLowerCase())) {
                    contractor = c;
                    remainder = remainder.substring(c.length).trim(); // Remove contractor from remainder
                    break;
                }
            }
            
            if (contractor === 'Unknown') {
                // Fallback: just grab the first word
                let parts = remainder.split(/\s+/);
                contractor = parts[0];
                remainder = parts.slice(1).join(' ').trim();
            }

            // 5. Extract Attendance & Supervisors
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
                        // It's a valid attendance code, add it to the calendar
                        datesArray[datePointer] = token.toUpperCase() === 'HO(ROTA)' ? 'HO (ROTA)' : token.toUpperCase();
                        datePointer++;
                    } else if (/^\d{1,2}$/.test(token)) {
                        // Stray number (likely a day header that bled in), ignore it safely
                        continue;
                    } else {
                        // We hit a word that IS NOT an attendance code (e.g., 'Nitesh').
                        // This means the dates are over and Supervisors have started!
                        parsingDates = false;
                        supTokens.push(token);
                    }
                } else {
                    supTokens.push(token);
                }
            }

            // 6. Split Supervisors roughly in half (TL / Sanctioner)
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
