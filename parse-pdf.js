const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const GAS_URL = "https://script.google.com/macros/s/AKfycbzBMx-fZAifindtXbsXVueYEYQz4uBT1cA8CnlrZH3MTHEyR4RMv6uxaPhdKwskiP4T/exec";

async function fetchAndParsePDF() {
    console.log("🌐 Fetching PDF from Google Apps Script...");

    const response = await fetch(GAS_URL);
    if (!response.ok) throw new Error("Network response was not ok");

    const json = await response.json();
    if (!json.success) throw new Error("GAS Error: " + json.error);

    // 🔴 Debug Log to ensure it's grabbing the right file!
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

    // Valid attendance codes used to identify date columns reliably
    const validAttSet = new Set(['p', 'mp', 'a', 'hd', 'wo', 'slwp', 'lvp', 'slp', 'pl', 'fd', 'l', 'ho', 'wwo', 'cf', 'who', 'ho(rota)', 'who(rota)', '-']);

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        let items = textContent.items
            .map(item => ({ text: item.str.trim(), x: item.transform[4], y: item.transform[5] }))
            .filter(item => item.text !== '');

        if (items.length === 0) continue;

        // 1. EXTRACT MONTH
        if (currentMonthStr === "Unknown Month") {
            let fullText = items.map(itm => itm.text).join(' ');
            let match = fullText.match(/Month\s*of\s*([A-Za-z]+)\s*(\d{4})/i) || fullText.replace(/\s/g, '').match(/Monthof([A-Za-z]+)(\d{4})/i);
            if (match) currentMonthStr = match[1] + " " + match[2];
        }

        // 2. GROUP BY Y COORDINATE 
        // (Tolerance increased to 12 to perfectly capture slightly misaligned rows)
        let rows = [];
        items.forEach(item => {
            let foundRow = rows.find(r => Math.abs(r.y - item.y) < 12);
            if (foundRow) foundRow.items.push(item);
            else rows.push({ y: item.y, items: [item] });
        });

        // 3. PARSE ROWS SEQUENTIALLY
        for (let row of rows) {
            row.items.sort((a, b) => a.x - b.x); // Sort elements left-to-right
            
            // Find where "Active" or "Left" is
            let statusIdx = row.items.findIndex(itm => {
                let t = itm.text.toLowerCase().replace(/[^a-z]/g, '');
                return t === 'active' || t === 'left';
            });

            if (statusIdx === -1) continue; // Skip header/empty rows

            let status = row.items[statusIdx].text.replace(/[^A-Za-z]/g, ''); // Ensure clean "Active" or "Left"

            // Extract Code and Name flawlessly
            let preStatusItems = row.items.slice(0, statusIdx);
            let preStatusText = preStatusItems.map(itm => itm.text).join(' ');
            
            let codeMatch = preStatusText.match(/([A-Z0-9]{2,8}\s*[-]?\s*\d{2,10})/i);
            if (!codeMatch) continue; 
            
            let code = codeMatch[1].replace(/\s+/g, '');
            let name = preStatusText.substring(codeMatch.index + codeMatch[0].length).trim();
            name = name.replace(/^[-\s]+/, ''); // Clean leading dashes/spaces

            let postStatus = row.items.slice(statusIdx + 1);

            // Re-connect "HO" and "(ROTA)" if PDF splits them
            for (let j = 0; j < postStatus.length - 1; j++) {
                let t1 = postStatus[j].text.toUpperCase().replace(/\s+/g, '');
                let t2 = postStatus[j+1].text.toUpperCase().replace(/\s+/g, '');
                if (t1 === 'HO' && t2 === '(ROTA)') {
                    postStatus[j].text = 'HO (ROTA)';
                    postStatus.splice(j+1, 1);
                    j--;
                }
            }

            let contractorRaw = "";
            let datesArray = new Array(31).fill('-');
            let supRaw = [];
            let datePointer = 0;
            let pastDatesSection = false;

            // Sequential Left-to-Right reading for everything after Status
            for (let item of postStatus) {
                let cleanText = item.text.toLowerCase().replace(/\s*\(pending\)/g, '').replace(/\s+/g, '');
                let isAttCode = validAttSet.has(cleanText) || /^[\d\.]+$/.test(cleanText);

                // 1. Grab Contractor (First non-attendance item)
                if (!contractorRaw && !isAttCode && cleanText.length > 2) {
                    contractorRaw = item.text;
                    continue;
                }

                // 2. Grab Attendance Codes (Fills up Day 1, Day 2, etc. sequentially)
                if (isAttCode && validAttSet.has(cleanText) && datePointer < 31 && !pastDatesSection) {
                    datesArray[datePointer] = cleanText === 'ho(rota)' ? 'HO (ROTA)' : cleanText.toUpperCase();
                    datePointer++;
                    continue;
                }

                // 3. Grab Supervisors (Everything at the end)
                if (item.text.length > 1 && !validAttSet.has(cleanText)) {
                    pastDatesSection = true; // Lock out dates once we hit supervisor names
                    supRaw.push(item.text);
                }
            }

            let contractor = cleanContractor(contractorRaw);
            
            // Split supervisors text into TL and Sanctioner roughly in half
            let tl = "N/A", sanctioner = "N/A";
            if (supRaw.length > 0) {
                let mid = Math.floor(supRaw.length / 2);
                if (mid === 0) {
                    tl = supRaw[0];
                    sanctioner = supRaw[0];
                } else {
                    tl = supRaw.slice(0, mid).join(' ').trim();
                    sanctioner = supRaw.slice(mid).join(' ').trim();
                }
            }

            // Push to Database
            if (name.length >= 2) {
                globalData.push({ code, name, status, contractor, dates: datesArray, tl, sanctioner });
            }
        }
    }

    console.log(`✅ Successfully parsed ${globalData.length} employee records.`);
    
    if (globalData.length === 0) {
        console.log("⚠️ WARNING: 0 records found. Double check the PDF Link printed above.");
    }

    fs.writeFileSync('data.json', JSON.stringify({ currentMonthStr, globalData }));
    console.log("🚀 Saved to data.json successfully!");
}

function cleanContractor(raw) {
    if (!raw) return "Unknown";
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
