let connection;
let numSlides = 0;
let slideImageUrls = [];

let slideDeckAlreadyDownloaded = false;
let slideDeckGenerationInProgress = false;

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

// Find the main canvas element that renders the current slide
let findSlideCanvas = () => {
    const canvases = document.querySelectorAll('canvas');
    if (canvases.length === 0) return null;

    let largestCanvas = null;
    let largestArea = 0;

    for (const canvas of canvases) {
        const rect = canvas.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > largestArea && rect.width > 100 && rect.height > 100) {
            largestArea = area;
            largestCanvas = canvas;
        }
    }

    return largestCanvas;
};

// Request a screenshot from the service worker via chrome.tabs.captureVisibleTab
let captureScreenshot = () => {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ requestType: "CAPTURE_VISIBLE_TAB" }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Screenshot request failed:', chrome.runtime.lastError.message);
                resolve(null);
                return;
            }
            resolve(response?.dataUrl || null);
        });
    });
};

// Crop a full-page screenshot to just the slide canvas area
let cropScreenshotToSlide = (screenshotDataUrl) => {
    const canvas = findSlideCanvas();
    if (!canvas) return Promise.resolve(screenshotDataUrl);

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const cropCanvas = document.createElement('canvas');
            const cropW = Math.round(rect.width * dpr);
            const cropH = Math.round(rect.height * dpr);
            cropCanvas.width = cropW;
            cropCanvas.height = cropH;

            const ctx = cropCanvas.getContext('2d');
            ctx.drawImage(
                img,
                Math.round(rect.left * dpr), Math.round(rect.top * dpr),
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

// Capture the current slide: screenshot the tab then crop to the slide area
let captureCurrentSlide = async () => {
    const screenshot = await captureScreenshot();
    if (!screenshot) return null;
    return cropScreenshotToSlide(screenshot);
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

// Get a checksum of the current screenshot for slide-change detection
let getSlideChecksum = async () => {
    const screenshot = await captureScreenshot();
    if (!screenshot) return null;
    // Use a sample from the middle of the data URL for a fast checksum
    const sample = screenshot.substring(
        Math.floor(screenshot.length * 0.3),
        Math.floor(screenshot.length * 0.3) + 2000
    );
    return calculateChecksum(sample);
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
    const firstSlide = await captureCurrentSlide();
    if (firstSlide) {
        slideImageUrls.push(firstSlide);
        slideCount = 1;
        previousChecksum = await getSlideChecksum();
        showCustomAlert(`Capturing Canva slides: ${slideCount} captured...`);
    } else {
        console.warn('Could not capture first slide');
        return 0;
    }

    // Cycle through remaining slides
    while (consecutiveNoChange < maxNoChange && slideCount < 500) {
        goToNextSlide();
        await new Promise(resolve => setTimeout(resolve, 1500));

        const currentChecksum = await getSlideChecksum();

        if (currentChecksum === previousChecksum) {
            consecutiveNoChange++;
            console.log(`No slide change detected (${consecutiveNoChange}/${maxNoChange})`);

            if (consecutiveNoChange < maxNoChange) {
                // Retry navigation in case it was slow
                goToNextSlide();
                await new Promise(resolve => setTimeout(resolve, 1500));
                const retryChecksum = await getSlideChecksum();
                if (retryChecksum !== previousChecksum) {
                    consecutiveNoChange = 0;
                    previousChecksum = retryChecksum;
                    slideCount++;
                    showCustomAlert(`Capturing Canva slides: ${slideCount} captured...`);
                    const slideData = await captureCurrentSlide();
                    if (slideData) slideImageUrls.push(slideData);
                }
            }
        } else {
            consecutiveNoChange = 0;
            previousChecksum = currentChecksum;
            slideCount++;
            showCustomAlert(`Capturing Canva slides: ${slideCount} captured...`);
            const slideData = await captureCurrentSlide();
            if (slideData) slideImageUrls.push(slideData);
        }
    }

    console.log(`Detected ${slideCount} Canva slides`);
    numSlides = slideCount;
    return slideCount;
};

let generateSlideDeckPdf = async () => {
    showCustomAlert('Detecting slides in Canva presentation...');

    // Wait for page to fully load
    await new Promise(resolve => setTimeout(resolve, 2000));

    showCustomAlert('Capturing Canva presentation slides...');
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
