let startTime;
let numSlidesComplete = 0;
const doc = new PDFDocument({layout:'landscape', margin: 0, autoFirstPage: false});
const stream = doc.pipe(blobStream());

const getImageAsBlob = async (url) => {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        console.error("Error fetching slide deck image:", url, e);
        throw e;
    }
}

// Batch download images with concurrency limit for optimal performance
const downloadImagesInBatches = async (imageUrls, batchSize = 5) => {
    const imageDataArray = [];
    
    for (let i = 0; i < imageUrls.length; i += batchSize) {
        const batch = imageUrls.slice(i, i + batchSize);
        const batchPromises = batch.map(url => getImageAsBlob(url));
        
        try {
            const batchResults = await Promise.all(batchPromises);
            imageDataArray.push(...batchResults);
            
            numSlidesComplete = Math.min(numSlidesComplete + batch.length, numSlides);
            showCustomAlert(`Generating slide deck as PDF: ${numSlidesComplete}/${numSlides} slides complete...`);
        } catch (e) {
            console.error(`Error in batch ${i / batchSize + 1}:`, e);
            // Continue with other batches even if one fails
            imageDataArray.push(...new Array(batch.length).fill(null));
        }
    }
    
    return imageDataArray;
}

const addSlidesToPDF = async (imageUrls) => {
    // Download all images concurrently in batches
    const imageDataArray = await downloadImagesInBatches(imageUrls);
    
    // Add images to PDF sequentially (required for PDF generation)
    for (let i = 0; i < imageDataArray.length; i++) {
        const data = imageDataArray[i];
        if (data) {
            try {
                const img = doc.openImage(data);
                doc.addPage({size: [img.width, img.height]});
                doc.image(img, 0, 0);
            } catch (e) {
                console.error(`Error adding slide ${i + 1} to PDF:`, e);
            }
        }
    }
}

const buildPdf = async (imageUrls) => {
    startTime = new Date().getTime();
    await addSlidesToPDF(imageUrls);
    doc.end();
}