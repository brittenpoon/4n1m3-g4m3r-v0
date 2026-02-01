// ==UserScript==
// @name         Costco History - V23 (V10 Core + Excel Fix)
// @namespace    http://tampermonkey.net/
// @version      23.0
// @description  Uses V10's robust query to fetch data, but exports as V19-style Excel to fix barcodes and add analysis.
// @author       You
// @match        https://www.costco.ca/*
// @run-at       document-start
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// ==/UserScript==

(function() {
    'use strict';

    let cachedHeaders = null;
    let hasInjectedOption = false;
    const REQUIRED_HEADERS = ['costco-x-authorization', 'client-identifier'];

    console.log("%c[Costco-V23] 啟動 - 混合修復模式", "color: white; background: #008000; font-size: 14px");

    // ==========================================
    // 1. Data Analysis (From V18/V19)
    // ==========================================
    function isGasItem(item) {
        const desc = (item.itemDescription01 || "").toUpperCase();
        const hasGasKeyword = desc.includes("REGULAR GAS") || desc.includes("PREMIUM GAS") || desc.includes("UNLEADED");
        const hasVolume = item.fuelUnitQuantity > 0;
        return hasGasKeyword && hasVolume;
    }

    function isExcludedFromAnalysis(item) {
        const desc = (item.itemDescription01 || "").toUpperCase();
        if (isGasItem(item)) return true;
        if (item.amount < 0) return true; // Returns
        if (desc.startsWith("TPD") || desc.startsWith("CPN") || desc.startsWith("OPN")) return true;
        if (desc.includes("ECO FEE") || desc.includes("DEPOSIT") || desc.includes("LEVY") || desc.includes("BAG FEE")) return true;
        if (desc.includes("SHOP CARD") || desc.includes("GIFT CARD")) return true;
        return false;
    }

    function analyzePriceDrops(flatData) {
        return flatData.map(currentItem => {
            if (currentItem.isExcluded) {
                return { ...currentItem, futureMinPrice: "", futureMinDate: "", cocoLink: "" };
            }

            const link = `https://cocoeast.ca/?s=${currentItem.itemNumber}`;
            const sameItems = flatData.filter(i => i.itemNumber === currentItem.itemNumber && !i.isExcluded);
            const futurePurchases = sameItems.filter(i => new Date(i.dateIso) > new Date(currentItem.dateIso));

            if (futurePurchases.length === 0) {
                return { ...currentItem, futureMinPrice: "N/A", futureMinDate: "", cocoLink: link };
            }

            futurePurchases.sort((a, b) => parseFloat(a.unitPrice) - parseFloat(b.unitPrice));
            const bestDeal = futurePurchases[0];

            return {
                ...currentItem,
                futureMinPrice: parseFloat(bestDeal.unitPrice),
                futureMinDate: bestDeal.dateStr,
                cocoLink: link
            };
        });
    }

    // ==========================================
    // 2. Excel Generation (Modified V19 Logic)
    // ==========================================
    function exportToExcel(orders) {
        const rawItems = [];

        orders.forEach(order => {
            const items = order.itemArray || [];
            
            // --- Logic from V10: Extract Deep Data ---
            
            // Taxes (V10 uses subTaxes)
            const taxes = order.subTaxes || {};
            const taxA = taxes.aTaxAmount || 0; 
            const taxB = taxes.bTaxAmount || 0;
            // order.taxes in V10 query is a scalar (Total Tax) or object? 
            // Based on V10 query `taxes`, it's likely total tax amount field.
            const taxTotal = order.taxes || (taxA + taxB);

            // Payments (V10 Logic)
            let tenderStr = "";
            let cardLast4 = "";
            let authCode = "";
            if (order.tenderArray && order.tenderArray.length > 0) {
                const tenders = order.tenderArray.map(t => `${t.tenderDescription} ($${t.amountTender})`);
                tenderStr = tenders.join(" + ");
                const mainCard = order.tenderArray.find(t => t.displayAccountNumber);
                if (mainCard) {
                    cardLast4 = mainCard.displayAccountNumber; // Usually masked
                    authCode = mainCard.approvalNumber || mainCard.tenderAuthorizationCode || "";
                }
            }

            // Subtotal
            const subtotal = order.subTotal || 0;
            const instantSavings = order.instantSavings || 0;

            if (items.length > 0) {
                items.forEach(item => {
                    const isGas = isGasItem(item);
                    const qty = isGas ? "" : (item.unit || 1);
                    const litres = isGas ? item.fuelUnitQuantity : "";
                    
                    let uPrice = 0;
                    if (isGas && item.itemUnitPriceAmount) {
                        uPrice = item.itemUnitPriceAmount;
                    } else {
                        uPrice = (item.amount / (qty || 1)).toFixed(2);
                    }

                    // Mapping to Excel Row
                    rawItems.push({
                        dateIso: order.transactionDateTime,
                        dateStr: new Date(order.transactionDateTime).toLocaleDateString(),
                        timeStr: new Date(order.transactionDateTime).toLocaleTimeString(),
                        warehouse: order.warehouseNumber,
                        warehouseName: order.warehouseName,
                        city: order.warehouseCity,
                        address: order.warehouseAddress1 || "",
                        
                        // 🟢 FIX: Force Excel Formula Format for Barcode
                        barcode: `="${order.transactionBarcode}"`,
                        invoice: `="${order.invoiceNumber || ""}"`,

                        totalOrder: order.total,
                        subtotal: subtotal,
                        instantSavings: instantSavings,
                        
                        taxTotal: taxTotal,
                        taxA: taxA > 0 ? taxA : "",
                        taxB: taxB > 0 ? taxB : "",
                        
                        payMethod: tenderStr,
                        cardLast4: cardLast4 ? `="${cardLast4}"` : "",
                        authCode: authCode ? `="${authCode}"` : "",

                        itemNumber: item.itemNumber,
                        dept: item.itemDepartmentNumber || "",
                        desc: item.itemDescription01,
                        unitWeight: item.unit || "", // Sometimes unit is weight
                        
                        qty: qty,
                        litres: litres,
                        unitPrice: uPrice,
                        lineAmount: item.amount,
                        taxable: item.taxFlag === "Y" ? "Yes" : "No",
                        
                        image: item.image || "",
                        isExcluded: isExcludedFromAnalysis(item)
                    });
                });
            } else {
                // Empty Receipt Handling
                rawItems.push({
                    dateIso: order.transactionDateTime,
                    dateStr: new Date(order.transactionDateTime).toLocaleDateString(),
                    timeStr: new Date(order.transactionDateTime).toLocaleTimeString(),
                    warehouse: order.warehouseNumber,
                    warehouseName: order.warehouseName,
                    city: order.warehouseCity,
                    address: order.warehouseAddress1 || "",
                    barcode: `="${order.transactionBarcode}"`,
                    invoice: `="${order.invoiceNumber || ""}"`,
                    totalOrder: order.total,
                    subtotal: subtotal,
                    instantSavings: instantSavings,
                    taxTotal: taxTotal,
                    taxA: taxA, taxB: taxB,
                    payMethod: tenderStr,
                    cardLast4: cardLast4 ? `="${cardLast4}"` : "",
                    authCode: authCode ? `="${authCode}"` : "",
                    itemNumber: "", dept: "", desc: "Transaction Record (No Items)", unitWeight: "",
                    qty: "", litres: "", unitPrice: "", lineAmount: 0, taxable: "",
                    image: "", isExcluded: true
                });
            }
        });

        // Run Analysis
        const analyzedItems = analyzePriceDrops(rawItems);

        // Define Headers
        const headers = [
            'Date', 'Time', 'Warehouse #', 'Warehouse Name', 'City', 'Address',
            'Receipt Barcode', 'Invoice #', 
            'Total Order', 'Subtotal', 'Instant Savings', 
            'Tax (Total)', 'GST/HST (Tax A)', 'PST/QST (Tax B)', 
            'Payment Method', 'Card (Last 4)', 'Auth Code', 
            'Item #', 'Department', 'Description', 
            'Unit/Weight', 'Qty / Litres', 'Unit Price / Gas Price', 
            'Line Amount', 'Taxable?', 
            'Image URL',
            'CocoEast Search Link', 'Lowest Future Price', 'Date of Future Low'
        ];

        // Map Data to Arrays
        const dataRows = analyzedItems.map(i => [
            i.dateStr, i.timeStr, i.warehouse, i.warehouseName, i.city, i.address,
            i.barcode, i.invoice,
            i.totalOrder, i.subtotal, i.instantSavings,
            i.taxTotal, i.taxA, i.taxB,
            i.payMethod, i.cardLast4, i.authCode,
            i.itemNumber, i.dept, i.desc,
            i.unitWeight, i.qty, i.litres, i.unitPrice, 
            i.lineAmount, i.taxable,
            i.image,
            i.cocoLink, i.futureMinPrice, i.futureMinDate
        ]);

        // Create Workbook
        const wb = XLSX.utils.book_new();
        const wsData = [headers, ...dataRows];
        const ws = XLSX.utils.aoa_to_sheet(wsData);

        // Add Hyperlinks
        const range = XLSX.utils.decode_range(ws['!ref']);
        for (let R = range.s.r + 1; R <= range.e.r; ++R) {
            const linkColIndex = 26; 
            const cellAddress = XLSX.utils.encode_cell({r: R, c: linkColIndex});
            const cell = ws[cellAddress];
            if (cell && cell.v && cell.v.startsWith("http")) {
                cell.l = { Target: cell.v, Tooltip: "Check CocoEast" };
            }
        }

        // Set Column Widths
        ws['!cols'] = [
            {wch:12}, {wch:10}, {wch:10}, {wch:15}, {wch:15}, {wch:25}, 
            {wch:25}, {wch:20}, 
            {wch:10}, {wch:10}, {wch:10}, 
            {wch:10}, {wch:10}, {wch:10}, 
            {wch:30}, {wch:10}, {wch:10}, 
            {wch:12}, {wch:10}, {wch:30}, 
            {wch:10}, {wch:8}, {wch:10}, 
            {wch:10}, {wch:8}, 
            {wch:30}, 
            {wch:40}, {wch:15}, {wch:15} 
        ];

        XLSX.utils.book_append_sheet(wb, ws, "Costco Data");
        const timestamp = new Date().toISOString().slice(0,10);
        XLSX.writeFile(wb, `Costco_History_V23_${timestamp}.xlsx`);
    }

    // ==========================================
    // 3. Interceptors (Same as V10/V19)
    // ==========================================
    function updateUIState(isReady) {
        const option = document.querySelector('option[value="CUSTOM_ALL"]');
        if (option) {
            if (isReady) {
                option.text = "📊 Ready! Download V23 (.xlsx)";
                option.style.color = "#008000"; 
                option.disabled = false;
            } else {
                option.text = "⏳ Waiting for Token...";
                option.style.color = "#999";
            }
        }
    }

    function checkHeaders(headers) {
        const keys = Object.keys(headers).map(k => k.toLowerCase());
        if (REQUIRED_HEADERS.every(req => keys.includes(req))) {
            cachedHeaders = { ...headers };
            updateUIState(true);
        }
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function(method, url) { this._customHeaders = {}; return originalOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
        if (this._customHeaders) this._customHeaders[header.toLowerCase()] = value;
        if (this._customHeaders) checkHeaders(this._customHeaders);
        return originalSetRequestHeader.apply(this, arguments);
    };

    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const [resource, config] = args;
        if (config && config.headers) {
             const headerObj = config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers;
             checkHeaders(headerObj);
        }
        return originalFetch(...args);
    };

    // ==========================================
    // 4. Execution (STRICTLY V10 QUERY)
    // ==========================================
    function getSafeHeaders() {
        if (!cachedHeaders) return null;
        const safe = { ...cachedHeaders };
        ['content-length', 'host', 'user-agent', 'origin', 'referer', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'].forEach(k => delete safe[k]);
        safe['content-type'] = 'application/json';
        return safe;
    }

    function getDates() {
        const now = new Date();
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const pad = (n) => n.toString().padStart(2, '0');
        return { 
            startDate: "12/01/2023", // V10 Default
            endDate: `${pad(now.getMonth() + 1)}/${pad(lastDay)}/${now.getFullYear()}` 
        };
    }

    async function executeChain() {
        if (!cachedHeaders) { alert("🛑 Token 未就緒，請先滾動頁面或點擊年份。"); return; }
        const headers = getSafeHeaders();
        const { startDate, endDate } = getDates();

        // 🛑 THIS IS THE V10 QUERY (Proven to work)
        const fullQuery = {
            "query": `query receiptsWithCounts($startDate: String!, $endDate: String!,$documentType:String!,$documentSubType:String!) {
                receiptsWithCounts(startDate: $startDate, endDate: $endDate,documentType:$documentType,documentSubType:$documentSubType) {
                    receipts {
                        warehouseNumber
                        warehouseName
                        warehouseCity
                        warehouseAddress1
                        warehousePostalCode
                        transactionDateTime
                        transactionBarcode
                        invoiceNumber
                        total
                        subTotal
                        taxes
                        instantSavings
                        
                        itemArray {
                            itemNumber
                            itemDescription01
                            amount
                            unit
                            taxFlag
                            itemDepartmentNumber
                            
                            # Gas Specifics
                            fuelUnitQuantity
                            itemUnitPriceAmount
                            fuelGradeDescription
                        }
                        
                        tenderArray {
                            tenderDescription
                            amountTender
                            displayAccountNumber
                            approvalNumber
                            tenderAuthorizationCode
                        }
                        
                        subTaxes {
                            aTaxAmount
                            bTaxAmount
                            cTaxAmount
                            dTaxAmount
                        }
                    }
                }
            }`,
            "variables": { "startDate": startDate, "endDate": endDate, "documentType": "all", "documentSubType": "all" }
        };

        let orderData = [];
        try {
            const res = await originalFetch("https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql", {
                headers, body: JSON.stringify(fullQuery), method: "POST"
            });
            const json = await res.json();
            
            // Re-added Error Handling from V10
            if (json.errors) {
                console.error(json.errors);
                alert("❌ Query Error: " + json.errors[0].message);
                return;
            }
            orderData = json.data?.receiptsWithCounts?.receipts || [];
        } catch (e) { alert("❌ Network Error: " + e.message); return; }

        if (orderData.length === 0) { alert("沒有找到數據"); return; }

        // Fetch Images Logic (Same as before)
        const allItemNumbers = [...new Set(orderData.flatMap(r => r.itemArray ? r.itemArray.map(i => i.itemNumber) : []))];
        let productMap = {};
        if (allItemNumbers.length > 0) {
            const productQuery = {
                "query": "query products($clientId:String!, $itemNumbers:[String], $locale:[String], $warehouseNumber:String!){\n      products(clientId:$clientId, itemNumbers:$itemNumbers, locale:$locale, warehouseNumber: $warehouseNumber) {\n        catalogData {\n          itemNumber\n          fieldData{ imageName }\n        }\n      }\n    }",
                "variables": {
                    "itemNumbers": allItemNumbers,
                    "clientId": headers['costco-x-wcs-clientid'] || "e442e6e6-2602-4a39-937b-8b28b4457ed3",
                    "locale": ["en-CA"],
                    "warehouseNumber": orderData[0]?.warehouseNumber || "894",
                    "channel": "site"
                }
            };
            try {
                const prodRes = await originalFetch("https://ecom-api.costco.com/ebusiness/product/v1/products/graphql", {
                    headers, body: JSON.stringify(productQuery), method: "POST"
                });
                const prodJson = await prodRes.json();
                if (prodJson.data?.products?.catalogData) {
                    prodJson.data.products.catalogData.forEach(p => {
                        productMap[p.itemNumber] = p.fieldData?.imageName || "";
                    });
                }
            } catch(e) { }
        }

        const enrichedOrders = orderData.map(receipt => ({
            ...receipt,
            itemArray: (receipt.itemArray || []).map(item => ({
                ...item,
                image: productMap[item.itemNumber] || ""
            }))
        }));

        console.log("💾 Generating Excel...");
        exportToExcel(enrichedOrders);
        console.log("✅ Download Complete.");
    }

    // ==========================================
    // 5. UI Injection (Same as V10)
    // ==========================================
    function addOptionToSelect() {
        const select = document.getElementById('Showing');
        if (select && !select.querySelector('option[value="CUSTOM_ALL"]')) {
            const newOption = document.createElement('option');
            newOption.value = "CUSTOM_ALL";
            newOption.text = "⏳ Waiting for Token...";
            newOption.style.fontWeight = "bold";
            newOption.style.color = "#999"; 
            select.insertBefore(newOption, select.firstChild);
            
            select.addEventListener('change', function(e) {
                if (e.target.value === 'CUSTOM_ALL') {
                    e.preventDefault(); e.stopPropagation();
                    executeChain();
                }
            });
            if (cachedHeaders) updateUIState(true);
            hasInjectedOption = true;
        }
    }

    const initObserver = () => {
        if (!document.body) { setTimeout(initObserver, 100); return; }
        const observer = new MutationObserver(() => { if (!hasInjectedOption) addOptionToSelect(); });
        observer.observe(document.body, { childList: true, subtree: true });
        addOptionToSelect();
    };
    initObserver();
})();
