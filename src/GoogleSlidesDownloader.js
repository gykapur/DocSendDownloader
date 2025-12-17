let connection;
let numSlides = 0;
let slideImageUrls = [];

let slideDeckAlreadyDownloaded = false;
let slideDeckGenerationInProgress = false;

// Detect if we're on a Google Slides public presentation
let isGoogleSlidesPage = () => {
    return window.location.href.includes('docs.google.com/presentation') && 
           (window.location.href.includes('/pub') || window.location.href.includes('/present'));
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

// Helper function to convert an image URL to a data URL
const imageUrlToDataUrl = async (url) => {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('Error converting image to data URL:', url, error);
        return null;
    }
};

// Helper function to inline all images in an SVG element
const inlineSvgImages = async (svgElement) => {
    // Find all image elements in the SVG
    const imageElements = svgElement.querySelectorAll('image');
    
    // Convert all image URLs to data URLs
    const imagePromises = Array.from(imageElements).map(async (imgEl) => {
        // Check both href and xlink:href attributes
        let imageUrl = imgEl.getAttribute('href') || imgEl.getAttribute('xlink:href');
        
        if (imageUrl) {
            // Remove xlink: namespace if present
            imageUrl = imageUrl.replace(/^xlink:/, '');
            
            // Skip if already a data URL
            if (imageUrl.startsWith('data:')) {
                return;
            }
            
            // Convert to absolute URL if relative
            if (imageUrl.startsWith('/') || !imageUrl.includes('://')) {
                imageUrl = new URL(imageUrl, window.location.href).href;
            }
            
            // Convert to data URL
            const dataUrl = await imageUrlToDataUrl(imageUrl);
            if (dataUrl) {
                // Update both href and xlink:href to ensure compatibility
                imgEl.setAttribute('href', dataUrl);
                imgEl.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', dataUrl);
            }
        }
    });
    
    await Promise.all(imagePromises);
};

// Helper function to get the current slide image from the DOM
// Google Slides public presentations render slides as images in .punch-viewer-svgpage-svgcontainer
let getCurrentSlideImage = async () => {
    const slideContent = document.querySelector('.punch-viewer-svgpage-svgcontainer');
    
    if (slideContent) {
        // Get SVG and serialize it into a string
        const svgElement = slideContent.querySelector('svg');
        if (svgElement) {
            // Get the actual rendered dimensions from the container or SVG
            const containerRect = slideContent.getBoundingClientRect();
            const svgRect = svgElement.getBoundingClientRect();
            
            // Use actual rendered size, or fallback to SVG attributes
            let width = svgRect.width || containerRect.width || svgElement.width?.baseVal?.value || 1920;
            let height = svgRect.height || containerRect.height || svgElement.height?.baseVal?.value || 1080;
            
            // If SVG has viewBox, use it to calculate aspect ratio
            const viewBox = svgElement.getAttribute('viewBox');
            if (viewBox && !svgElement.width?.baseVal?.value) {
                const [x, y, vbWidth, vbHeight] = viewBox.split(/\s+|,/).map(parseFloat);
                if (vbWidth && vbHeight) {
                    // Use viewBox aspect ratio with container width
                    if (containerRect.width) {
                        height = (containerRect.width / vbWidth) * vbHeight;
                        width = containerRect.width;
                    } else {
                        width = vbWidth;
                        height = vbHeight;
                    }
                }
            }
            
            // Use high resolution (2x for better quality)
            const scale = 2;
            const canvasWidth = Math.round(width * scale);
            const canvasHeight = Math.round(height * scale);
            
            // Clone SVG to avoid modifying the original
            const svgClone = svgElement.cloneNode(true);
            
            // Inline all images in the cloned SVG
            await inlineSvgImages(svgClone);
            
            // Set explicit width and height on the cloned SVG
            svgClone.setAttribute('width', width);
            svgClone.setAttribute('height', height);
            svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            
            const serializer = new XMLSerializer();
            let svgString = serializer.serializeToString(svgClone);
            
            // Convert SVG string to Blob and create URL
            const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
            const svgUrl = URL.createObjectURL(svgBlob);
            
            return new Promise((resolve) => {
                const img = new Image();
                img.onload = function () {
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = canvasWidth;
                        canvas.height = canvasHeight;
                        const ctx = canvas.getContext('2d');
                        
                        // Enable image smoothing for better quality
                        ctx.imageSmoothingEnabled = true;
                        ctx.imageSmoothingQuality = 'high';
                        
                        // Draw the image scaled up
                        ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);
                        
                        const pngDataUrl = canvas.toDataURL('image/png', 1.0); // Highest quality
                        URL.revokeObjectURL(svgUrl); // Clean up
                        resolve(pngDataUrl);
                    } catch (error) {
                        console.error('Error drawing image to canvas:', error);
                        URL.revokeObjectURL(svgUrl);
                        resolve(null);
                    }
                };
                img.onerror = (error) => {
                    console.error('Error loading SVG image:', error);
                    URL.revokeObjectURL(svgUrl); // Clean up
                    resolve(null);
                };
                img.src = svgUrl;
            });
        }
    }
    return null;
};

// Helper function to get checksum from current slide image
let getSlideChecksum = () => {
    const slideContent = document.querySelector('.punch-viewer-svgpage-svgcontainer');
    if (slideContent) {
        const svgElement = slideContent.querySelector('svg');
        if (svgElement) {
            const serializer = new XMLSerializer();
            const svgString = serializer.serializeToString(svgElement);
            return calculateChecksum(svgString);
        }
    }
    return null;
};

// Detect slide count and capture slides by cycling through with 'n' key
let detectAndCaptureSlidesByNKey = async () => {
    console.log('Detecting slides by cycling through with "n" key');
    slideImageUrls = [];
    
    // Go to first slide using Home key
    const homeEvent = new KeyboardEvent('keydown', { 
        key: 'Home', 
        code: 'Home', 
        keyCode: 36, 
        bubbles: true,
        cancelable: true
    });
    document.dispatchEvent(homeEvent);
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    let slideCount = 0;
    let previousChecksum = null;
    let consecutiveNoChange = 0;
    const maxNoChange = 3; // Stop after 3 consecutive presses with no change
    
    // Capture current slide using the helper function
    const captureCurrentSlide = async () => {
        const slideImg = await getCurrentSlideImage();
        if (slideImg) {
            slideImageUrls.push(slideImg);
            console.log(`Captured slide ${slideCount} using "n" key method`);
            return true;
        }
        console.warn(`Could not capture slide ${slideCount + 1}`);
        return false;
    };
    
    // Capture first slide
    await new Promise(resolve => setTimeout(resolve, 1000));
    await captureCurrentSlide();
    slideCount = 1;
    previousChecksum = getSlideChecksum();
    showCustomAlert(`Detecting slides: ${slideCount} found...`);
    
    // Cycle through slides by pressing 'n' key
    while (consecutiveNoChange < maxNoChange && slideCount < 500) { // Safety limit of 500 slides
        // Press 'n' key to go to next slide
        const nKeyEvent = new KeyboardEvent('keydown', {
            key: 'n',
            code: 'KeyN',
            keyCode: 78,
            bubbles: true,
            cancelable: true
        });
        document.dispatchEvent(nKeyEvent);
        
        // Wait for slide to change
        await new Promise(resolve => setTimeout(resolve, 1200));
        
        // Check if slide changed using checksum
        const currentChecksum = getSlideChecksum();
        
        if (currentChecksum === previousChecksum) {
            consecutiveNoChange++;
            console.log(`No slide change detected (attempt ${consecutiveNoChange}/${maxNoChange})`);
            
            // Try pressing 'n' a few more times in case it's slow to respond
            if (consecutiveNoChange < maxNoChange) {
                document.dispatchEvent(nKeyEvent);
                await new Promise(resolve => setTimeout(resolve, 800));
                const retryChecksum = getSlideChecksum();
                if (retryChecksum !== previousChecksum) {
                    consecutiveNoChange = 0; // Reset if it changed on retry
                    previousChecksum = retryChecksum;
                    slideCount++;
                    showCustomAlert(`Detecting slides: ${slideCount} found...`);
                    await captureCurrentSlide();
                }
            }
        } else {
            // Slide changed, capture it
            consecutiveNoChange = 0;
            previousChecksum = currentChecksum;
            slideCount++;
            
            // Update progress
            showCustomAlert(`Detecting slides: ${slideCount} found...`);
            
            // Capture the slide
            await captureCurrentSlide();
        }
    }
    
    console.log(`Detected ${slideCount} slides using "n" key method`);
    numSlides = slideCount;
    return slideCount;
};

let generateSlideDeckPdf = async () => {
    showCustomAlert('Detecting slides in Google Slides presentation...');
    
    // Wait for page to fully load
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Use 'n' key method to detect and capture slides
    showCustomAlert('Detecting slides by cycling through presentation...');
    const detectedCount = await detectAndCaptureSlidesByNKey();
    
    if (detectedCount > 0 && slideImageUrls.length > 0) {
        numSlides = slideImageUrls.length;
        console.log(`Successfully detected and captured ${numSlides} slides`);
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
        if (isGoogleSlidesPage()) {
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
            showDefaultAlert("This page does not appear to be a Google Slides presentation.")
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
