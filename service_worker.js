let connection;
let jobInProgress = false;
let jobComplete = false;

const docSendScriptsToInject = [
    "./modules/pdfkit.js",
    "./modules/blob-stream.js",
    "./src/ModifyDocSendView.js",
    "./src/GeneratePDF.js",
    "./src/DocSendDownloader.js"
];

const googleSlidesScriptsToInject = [
    "./modules/pdfkit.js",
    "./modules/blob-stream.js",
    "./src/ModifyDocSendView.js",
    "./src/GeneratePDF.js",
    "./src/GoogleSlidesDownloader.js"
];

const canvaScriptsToInject = [
    "./modules/pdfkit.js",
    "./modules/blob-stream.js",
    "./src/ModifyDocSendView.js",
    "./src/GeneratePDF.js",
    "./src/CanvaDownloader.js"
];

// Check if URL is a DocSend page
const isDocSendPage = (url) => {
    if (!url) return false;
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.includes('docsend.com') || 
               urlObj.hostname.includes('docsend.dropbox.com');
    } catch {
        return false;
    }
};

// Check if URL is a Google Slides page
const isGoogleSlidesPage = (url) => {
    if (!url) return false;
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.includes('docs.google.com') && 
               urlObj.pathname.includes('/presentation');
    } catch {
        return false;
    }
};

// Check if URL is a Canva presentation page
const isCanvaPage = (url) => {
    if (!url) return false;
    try {
        const urlObj = new URL(url);
        return urlObj.hostname.includes('canva.com') &&
               urlObj.pathname.includes('/design/');
    } catch {
        return false;
    }
};

// Check if URL is a supported slide deck page
const isSupportedSlideDeckPage = (url) => {
    return isDocSendPage(url) || isGoogleSlidesPage(url) || isCanvaPage(url);
};

// Create a greyed out version of an icon as ImageData
const createGreyedOutIconData = async (iconPath, size) => {
    try {
        const response = await fetch(chrome.runtime.getURL(iconPath));
        const blob = await response.blob();
        const imageBitmap = await createImageBitmap(blob);
        
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');
        
        // Draw the original image
        ctx.drawImage(imageBitmap, 0, 0, size, size);
        
        // Apply greyscale filter
        const imageData = ctx.getImageData(0, 0, size, size);
        const data = imageData.data;
        
        for (let i = 0; i < data.length; i += 4) {
            // Convert to greyscale and reduce opacity
            const grey = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
            data[i] = grey;     // R
            data[i + 1] = grey; // G
            data[i + 2] = grey; // B
            data[i + 3] = Math.floor(data[i + 3] * 0.5); // Reduce opacity to 50%
        }
        
        return imageData;
    } catch (e) {
        console.error('Error creating greyed out icon:', e);
        return null;
    }
};

// Update icon based on whether we're on a supported slide deck page
const updateIcon = async (tabId) => {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.url) return;
        
        if (isSupportedSlideDeckPage(tab.url)) {
            // Set normal icon
            chrome.action.setIcon({
                tabId: tabId,
                path: {
                    16: "./assets/icon16.png",
                    48: "./assets/icon48.png",
                    128: "./assets/icon128.png"
                }
            });
            let title = "Download slide deck as PDF";
            if (isDocSendPage(tab.url)) {
                title = "Download a DocSend slide deck as a PDF";
            } else if (isGoogleSlidesPage(tab.url)) {
                title = "Download a Google Slides presentation as a PDF";
            } else if (isCanvaPage(tab.url)) {
                title = "Download a Canva presentation as a PDF";
            }
            chrome.action.setTitle({
                tabId: tabId,
                title: title
            });
            chrome.action.setBadgeText({ tabId: tabId, text: "" });
        } else {
            // Set greyed out icon
            const grey16 = await createGreyedOutIconData("./assets/icon16.png", 16);
            const grey48 = await createGreyedOutIconData("./assets/icon48.png", 48);
            const grey128 = await createGreyedOutIconData("./assets/icon128.png", 128);
            
            if (grey16 && grey48 && grey128) {
                chrome.action.setIcon({
                    tabId: tabId,
                    imageData: {
                        16: grey16,
                        48: grey48,
                        128: grey128
                    }
                });
            }
            chrome.action.setTitle({
                tabId: tabId,
                title: "Slide Deck Downloader (Not on a supported slide deck page)"
            });
        }
    } catch (e) {
        console.error('Error updating icon:', e);
    }
};

// Update icon when tab is updated
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        updateIcon(tabId);
    }
});

// Update icon when tab is activated
chrome.tabs.onActivated.addListener((activeInfo) => {
    updateIcon(activeInfo.tabId);
});

// Initialize icon for current tab on extension load
chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    if (tabs[0]) {
        updateIcon(tabs[0].id);
    }
});

const executeJob = () => {
    jobInProgress = true;
    chrome.tabs.query({active: true, currentWindow: true}, async (tabs) => {
        const currentTabId = tabs[0].id;
        const currentUrl = tabs[0].url;

        // Determine which scripts to inject based on the page type
        let scriptsToInject;
        if (isCanvaPage(currentUrl)) {
            scriptsToInject = canvaScriptsToInject;
        } else if (isGoogleSlidesPage(currentUrl)) {
            scriptsToInject = googleSlidesScriptsToInject;
        } else if (isDocSendPage(currentUrl)) {
            scriptsToInject = docSendScriptsToInject;
        } else {
            // Fallback to DocSend scripts (shouldn't happen due to click handler check)
            scriptsToInject = docSendScriptsToInject;
        }

        chrome.scripting
        .executeScript({
            target: {
                tabId: currentTabId,
            },
            files: scriptsToInject
        })
        .then(() => {
            connection = chrome.tabs.connect(currentTabId);
            connection.postMessage({requestType: "GENERATE_PDF"});
            connection.onMessage.addListener((message) => {
                if (message.requestType == "SET_JOB_COMPLETE") {
                    jobInProgress = false;
                    jobComplete = true;
                }
            })
        })
    })
}

chrome.action.onClicked.addListener(async () => {
    // Get the current active tab and check if we're on a supported slide deck page
    const tabs = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tabs[0] || !isSupportedSlideDeckPage(tabs[0].url)) {
        // Not on a supported page - do nothing (icon is already greyed out)
        return;
    }
    
    if (jobComplete || jobInProgress) {
        try {
            connection.postMessage({requestType: "CHECK_PROGRESS"});
        } 
        catch {
            //Connection closed, start new job
            executeJob();
        }
    }
    else if (!jobInProgress && !jobComplete) {
        executeJob();
    }
})