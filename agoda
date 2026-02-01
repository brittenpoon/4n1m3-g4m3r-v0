// ==UserScript==
// @name         Agoda Auto Tab Opener
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Automatically opens hotel pages in new tabs from Agoda landing page
// @author       Britten
// @match        https://www.agoda.com/zh-hk/hsbcpremierhk*
// @match        https://www.agoda.com/hsbcpremierhk*
// @match        https://www.agoda.com/*hsbcpremierhk*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // List of hotel URLs to open automatically
    const hotelLinks = [
        "https://www.agoda.com/zh-hk/sapporo-hotel-by-granbell/hotel/sapporo-jp.html?checkin=2025-10-14",
        "https://www.agoda.com/zh-hk/sapporo-hotel-by-granbell/hotel/sapporo-jp.html?checkin=2025-10-19",
        "https://www.agoda.com/zh-hk/jozankei-view-hotel/hotel/sapporo-jp.html?checkIn=2025-10-16",
        "https://www.agoda.com/zh-hk/la-vista-furano-hills/hotel/furano-jp.html?checkIn=2025-10-18",
        "https://www.agoda.com/zh-hk/hotel-park-hills/hotel/furano-jp.html?checkIn=2025-10-17",
        "https://www.agoda.com/zh-hk/sounkyo-kanko-hotel/hotel/asahikawa-jp.html?checkIn=2025-10-18"
    ];

    // Delay between opening tabs (in milliseconds) to prevent browser blocking
    const delay = 1000;

    console.log("Agoda Auto Tab Opener: Starting to open " + hotelLinks.length + " links...");

    hotelLinks.forEach((url, index) => {
        setTimeout(() => {
            console.log("Opening: " + url);
            window.open(url, '_blank');
        }, index * delay);
    });
})();
