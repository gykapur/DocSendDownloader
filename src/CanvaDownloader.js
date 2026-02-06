let connection;
let numSlides = 0;
let slideImageUrls = [];

let slideDeckAlreadyDownloaded = false;
let slideDeckGenerationInProgress = false;
let lastAlertMessage = '';

// Detect if we're on a Canva presentation page
let isCanvaPage = () => {
    return window.location.href.includes('canva.com/design/');
};

// Helper function to calculate a simple checksum from a string
let calculateChecksum = (str) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString();
};

// Wrapper around showCustomAlert that also remembers the message so we can
// restore it after hiding for a clean screenshot.
let showProgress = (message) => {
    lastAlertMessage = message;
    showCustomAlert(message);
};

// Find the bounding rect of the slide area.
// Canva scales its slide container with transform: scale(...), so we look
// for the largest div that carries a scale transform.  Returns a DOMRect or null.
let findSlideRect = () => {
    let bestRect = null;
    let bestArea = 0;

    const divs = document.querySelectorAll('div');
    for (const div of divs) {
        const transform = div.style.transform || getComputedStyle(div).transform;
        if (!transform || transform === 'none') continue;

        // Match transform values that contain a scale component
        // Covers: scale(0.5), matrix(0.5, 0, 0, 0.5, ...), scaleX, scaleY etc.
        if (!/scale|matrix/.test(transform)) continue;

        const rect = div.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea && rect.width > 100 && rect.height > 100) {
            bestArea = area;
            bestRect = rect;
        }
    }

    return bestRect;
};

// Request a screenshot from the service worker via chrome.tabs.captureVisibleTab.
// Hides our alert overlay first so it never appears in the capture.
let captureCleanScreenshot = async () => {
    // Hide alert so it does not appear in the screenshot
    hideCustomAlert();
    await new Promise(resolve => setTimeout(resolve, 50));

    const dataUrl = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ requestType: "CAPTURE_VISIBLE_TAB" }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Screenshot request failed:', chrome.runtime.lastError.message);
                resolve(null);
                return;
            }
            resolve(response?.dataUrl || null);
        });
    });

    // Restore alert
    if (lastAlertMessage) showCustomAlert(lastAlertMessage);
    return dataUrl;
};

// Crop a full-page screenshot to just the slide area
let cropScreenshotToSlide = (screenshotDataUrl, slideRect) => {
    if (!slideRect) return Promise.resolve(screenshotDataUrl);

    const dpr = window.devicePixelRatio || 1;

    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const cropCanvas = document.createElement('canvas');
            const cropW = Math.round(slideRect.width * dpr);
            const cropH = Math.round(slideRect.height * dpr);
            cropCanvas.width = cropW;
            cropCanvas.height = cropH;

            const ctx = cropCanvas.getContext('2d');
            ctx.drawImage(
                img,
                Math.round(slideRect.left * dpr), Math.round(slideRect.top * dpr),
                cropW, cropH,
                0, 0,
                cropW, cropH
            );
            resolve(cropCanvas.toDataURL('image/png'));
        };
        img.onerror = () => resolve(screenshotDataUrl);
        img.src = screenshotDataUrl;
    });
};

// Capture the current slide and compute its checksum in one shot.
// Returns { image, checksum } using the cropped slide-only image for both.
let captureSlideWithChecksum = async () => {
    const slideRect = findSlideRect();
    const screenshot = await captureCleanScreenshot();
    if (!screenshot) return { image: null, checksum: null };

    const croppedImage = await cropScreenshotToSlide(screenshot, slideRect);

    // Checksum a sample from the cropped image (slide content only)
    const sample = croppedImage.substring(
        Math.floor(croppedImage.length * 0.3),
        Math.floor(croppedImage.length * 0.3) + 2000
    );
    const checksum = calculateChecksum(sample);

    return { image: croppedImage, checksum };
};

// Dispatch a keyboard event on multiple targets so Canva's listeners pick it up
let sendKey = (key, code, keyCode) => {
    const opts = { key, code, keyCode, bubbles: true, cancelable: true, composed: true };
    const event = () => new KeyboardEvent('keydown', opts);
    document.dispatchEvent(event());
    document.body.dispatchEvent(event());
    window.dispatchEvent(event());
    if (document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement) {
        document.activeElement.dispatchEvent(event());
    }
};

// Try to click a navigation button in the DOM as fallback for keyboard nav
let clickNavButton = (direction) => {
    const buttons = document.querySelectorAll('button, [role="button"], [aria-label]');
    for (const btn of buttons) {
        const label = (btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase();
        if (direction === 'next' && (label.includes('next') || label.includes('forward'))) {
            btn.click();
            return true;
        }
        if (direction === 'prev' && (label.includes('prev') || label.includes('back'))) {
            btn.click();
            return true;
        }
    }
    return false;
};

// Navigate to the next slide using keyboard + button click fallback
let goToNextSlide = () => {
    sendKey('ArrowRight', 'ArrowRight', 39);
    clickNavButton('next');
};

// Navigate to the previous slide
let goToPrevSlide = () => {
    sendKey('ArrowLeft', 'ArrowLeft', 37);
    clickNavButton('prev');
};

// Navigate through all slides and capture each one
let detectAndCaptureSlides = async () => {
    console.log('Detecting and capturing Canva slides...');
    slideImageUrls = [];

    // Navigate to the first slide
    sendKey('Home', 'Home', 36);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Press ArrowLeft many times to ensure we are at the very beginning
    for (let i = 0; i < 50; i++) {
        goToPrevSlide();
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    await new Promise(resolve => setTimeout(resolve, 2000));

    let slideCount = 0;
    let previousChecksum = null;
    let consecutiveNoChange = 0;
    const maxNoChange = 3;

    // Capture first slide
    await new Promise(resolve => setTimeout(resolve, 1000));
    const first = await captureSlideWithChecksum();
    if (first.image) {
        slideImageUrls.push(first.image);
        slideCount = 1;
        previousChecksum = first.checksum;
        showProgress(`Capturing Canva slides: ${slideCount} captured...`);
    } else {
        console.warn('Could not capture first slide');
        return 0;
    }

    // Cycle through remaining slides
    while (consecutiveNoChange < maxNoChange && slideCount < 500) {
        goToNextSlide();
        await new Promise(resolve => setTimeout(resolve, 1500));

        const { image, checksum } = await captureSlideWithChecksum();

        if (checksum === previousChecksum) {
            consecutiveNoChange++;
            console.log(`No slide change detected (${consecutiveNoChange}/${maxNoChange})`);

            if (consecutiveNoChange < maxNoChange) {
                // Retry navigation in case it was slow
                goToNextSlide();
                await new Promise(resolve => setTimeout(resolve, 1500));
                const retry = await captureSlideWithChecksum();
                if (retry.checksum !== previousChecksum) {
                    consecutiveNoChange = 0;
                    previousChecksum = retry.checksum;
                    slideCount++;
                    showProgress(`Capturing Canva slides: ${slideCount} captured...`);
                    if (retry.image) slideImageUrls.push(retry.image);
                }
            }
        } else {
            consecutiveNoChange = 0;
            previousChecksum = checksum;
            slideCount++;
            showProgress(`Capturing Canva slides: ${slideCount} captured...`);
            if (image) slideImageUrls.push(image);
        }
    }

    console.log(`Detected ${slideCount} Canva slides`);
    numSlides = slideCount;
    return slideCount;
};

let generateSlideDeckPdf = async () => {
    showProgress('Detecting slides in Canva presentation...');

    // Wait for page to fully load
    await new Promise(resolve => setTimeout(resolve, 2000));

    showProgress('Capturing Canva presentation slides...');
    const detectedCount = await detectAndCaptureSlides();

    if (detectedCount > 0 && slideImageUrls.length > 0) {
        numSlides = slideImageUrls.length;
        console.log(`Successfully captured ${numSlides} Canva slides`);
        buildPdf(slideImageUrls);
        return;
    }

    // No slides found
    showDefaultAlert('Could not extract slide images. Please ensure the presentation is fully loaded and try again.');
    slideDeckGenerationInProgress = false;
};

chrome.runtime.onConnect.addListener((port) => {
    connection = port;
    port.onMessage.addListener((message) => {
        if (isCanvaPage()) {
            if (message.requestType == "GENERATE_PDF") {
                slideDeckGenerationInProgress = true;
                slideDeckAlreadyDownloaded = true;
                generateSlideDeckPdf();
            }
            else if (message.requestType == "CHECK_PROGRESS") {
                if (slideDeckGenerationInProgress) {
                    showCustomAlert("Please wait. Still generating slide deck as PDF...");
                }
                else if (slideDeckAlreadyDownloaded) {
                    showDefaultAlert("Slide deck was already downloaded during this session. Please reload the page to download again.")
                } else {
                    showDefaultAlert("ERROR: Slide deck download progress unknown. Please try again.");
                }
            }
        } else {
            showDefaultAlert("This page does not appear to be a Canva presentation.")
        }
    })
});

// Listen for PDF generation completion (from GeneratePDF.js)
stream.on("finish", () => {
    slideDeckGenerationInProgress = false;
    let blobUrl = stream.toBlobURL('application/pdf');
    let totalTime = new Date().getTime() - startTime;
    initiateDownload(blobUrl);
    hideCustomAlert();
    showDefaultAlert("Done ! Slide deck PDF generated in " + String(totalTime) + " ms.");
    connection.postMessage({requestType: "SET_JOB_COMPLETE"});
});
