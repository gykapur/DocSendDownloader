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
        // Select the largest visible canvas element (the slide)
        if (area > largestArea && rect.width > 100 && rect.height > 100) {
            largestArea = area;
            largestCanvas = canvas;
        }
    }

    return largestCanvas;
};

// Check if an element is visible in the viewport
let isElementVisible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
        rect.top < window.innerHeight && rect.bottom > 0 &&
        rect.left < window.innerWidth && rect.right > 0;
};

// Try to capture the current slide from canvas element
let captureFromCanvas = () => {
    const canvas = findSlideCanvas();
    if (!canvas) return null;

    try {
        const dataUrl = canvas.toDataURL('image/png', 1.0);
        if (dataUrl && dataUrl !== 'data:,') {
            return dataUrl;
        }
    } catch (e) {
        console.warn('Canvas capture failed (possibly tainted):', e.message);
    }
    return null;
};

// Fallback: try to capture from image elements in the slide container
let captureFromDOM = async () => {
    const images = document.querySelectorAll('img');
    let slideImage = null;
    let largestArea = 0;

    for (const img of images) {
        const rect = img.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > largestArea && rect.width > 200 && rect.height > 100 && isElementVisible(img)) {
            largestArea = area;
            slideImage = img;
        }
    }

    if (slideImage && slideImage.src) {
        try {
            const response = await fetch(slideImage.src);
            const blob = await response.blob();
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (e) {
            console.warn('Failed to fetch slide image:', e);
        }
    }

    return null;
};

// Get a checksum of the current visible slide content
let getSlideChecksum = () => {
    const canvas = findSlideCanvas();
    if (canvas) {
        try {
            const ctx = canvas.getContext('2d');
            if (ctx) {
                // Sample a small region of the canvas for a fast checksum
                const sampleWidth = Math.min(canvas.width, 100);
                const sampleHeight = Math.min(canvas.height, 100);
                const imageData = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
                return calculateChecksum(Array.from(imageData.data.slice(0, 1000)).join(','));
            }
        } catch (e) {
            // Canvas may be tainted; fall back to DOM-based checksum
        }
    }

    // Fallback: checksum based on visible image sources
    const images = document.querySelectorAll('img');
    const visibleSrcs = Array.from(images)
        .filter(img => isElementVisible(img))
        .map(img => img.src)
        .join('|');
    if (visibleSrcs.length > 0) {
        return calculateChecksum(visibleSrcs);
    }

    return null;
};

// Capture the current slide using best available method
let captureCurrentSlide = async () => {
    // Try canvas capture first (primary method for Canva)
    let slideData = captureFromCanvas();
    if (slideData) return slideData;

    // Fall back to DOM image capture
    slideData = await captureFromDOM();
    return slideData;
};

// Send a keyboard event to navigate slides
let sendKey = (key, code, keyCode) => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
        key, code, keyCode,
        bubbles: true,
        cancelable: true
    }));
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
        sendKey('ArrowLeft', 'ArrowLeft', 37);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    await new Promise(resolve => setTimeout(resolve, 1500));

    let slideCount = 0;
    let previousChecksum = null;
    let consecutiveNoChange = 0;
    const maxNoChange = 3; // Stop after 3 consecutive presses with no change

    // Capture first slide
    await new Promise(resolve => setTimeout(resolve, 1000));
    const firstSlide = await captureCurrentSlide();
    if (firstSlide) {
        slideImageUrls.push(firstSlide);
        slideCount = 1;
        previousChecksum = getSlideChecksum();
        showCustomAlert(`Capturing Canva slides: ${slideCount} captured...`);
    } else {
        console.warn('Could not capture first slide');
        return 0;
    }

    // Cycle through remaining slides using ArrowRight
    while (consecutiveNoChange < maxNoChange && slideCount < 500) {
        sendKey('ArrowRight', 'ArrowRight', 39);
        await new Promise(resolve => setTimeout(resolve, 1500));

        const currentChecksum = getSlideChecksum();

        if (currentChecksum === previousChecksum) {
            consecutiveNoChange++;
            console.log(`No slide change detected (${consecutiveNoChange}/${maxNoChange})`);

            if (consecutiveNoChange < maxNoChange) {
                // Retry navigation in case it was slow to respond
                sendKey('ArrowRight', 'ArrowRight', 39);
                await new Promise(resolve => setTimeout(resolve, 1000));
                const retryChecksum = getSlideChecksum();
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
