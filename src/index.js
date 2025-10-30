const imaging = window.require('photoshop').imaging; 
const photoshop = window.require('photoshop');
const core = photoshop.core;
const uxp = window.require('uxp');
const localFileSystem = uxp.storage.localFileSystem; 
const action = photoshop.action;
const app = photoshop.app; // Ensure app is defined for easier access
const constants = photoshop.constants;
const { executeAction, stringIDToTypeID, charIDToTypeID } = require('photoshop').action;
const DialogModes = require('photoshop').action.DialogModes; 

// Global API key reference
let API_KEY_REF = '';

// --- Utility Functions ---
const SUPPORTED_ASPECT_RATIOS = [
    { ratio: 1/1, width: 1024, height: 1024, name: "1:1" },
    { ratio: 2/3, width: 832, height: 1248, name: "2:3" },
    { ratio: 3/2, width: 1248, height: 832, name: "3:2" },
    { ratio: 3/4, width: 864, height: 1184, name: "3:4" },
    { ratio: 4/3, width: 1184, height: 864, name: "4:3" },
    { ratio: 4/5, width: 896, height: 1152, name: "4:5" },
    { ratio: 5/4, width: 1152, height: 896, name: "5:4" },
    { ratio: 9/16, width: 768, height: 1344, name: "9:16" },
    { ratio: 16/9, width: 1344, height: 768, name: "16:9" },
    { ratio: 21/9, width: 1536, height: 672, name: "21:9" }
];

// Settings management functions
function loadSettings() {
    const settings = localStorage.getItem('pluginSettings');
    if (settings) {
        const parsed = JSON.parse(settings);
        
        // Load API key and update global reference
        if (parsed.apiKey) {
            API_KEY_REF = parsed.apiKey;
            // Update both input fields to maintain consistency
            const apiKeyInput = document.getElementById('api-key');
            const openrouterApiKeyInput = document.getElementById('openrouter-api-key-input');
            if (apiKeyInput) apiKeyInput.value = parsed.apiKey;
            if (openrouterApiKeyInput) openrouterApiKeyInput.value = parsed.apiKey;
        }
        
        // Load model settings
        if (parsed.textModel) {
            const textModelInput = document.getElementById('setting-text-model');
            if (textModelInput) textModelInput.value = parsed.textModel;
        }
        
        if (parsed.visionModel) {
            const visionModelInput = document.getElementById('setting-vision-model');
            if (visionModelInput) visionModelInput.value = parsed.visionModel;
        }
        
        if (parsed.imageModel) {
            const imageModelInput = document.getElementById('setting-image-model');
            if (imageModelInput) imageModelInput.value = parsed.imageModel;
        }
        
        if (parsed.optimizerPrompt) {
            const optimizerPromptInput = document.getElementById('setting-optimizer-prompt');
            if (optimizerPromptInput) optimizerPromptInput.value = parsed.optimizerPrompt;
        }
        
        return parsed;
    }
    return null;
}

function saveSettings() {
    const settings = {
        apiKey: document.getElementById('openrouter-api-key-input')?.value || '',
        textModel: document.getElementById('setting-text-model')?.value || 'google/gemini-2.0-flash-001',
        visionModel: document.getElementById('setting-vision-model')?.value || 'google/gemini-2.0-flash-001',
        imageModel: document.getElementById('setting-image-model')?.value || 'google/gemini-2.5-flash-image',
        optimizerPrompt: document.getElementById('setting-optimizer-prompt')?.value || 'act as image generation prompt engineer and optimize user prompt'
    };
    
    localStorage.setItem('pluginSettings', JSON.stringify(settings));
    // Update the global API key reference
    API_KEY_REF = settings.apiKey;
}


function getImageDimensions(base64Data) {
    return new Promise((resolve) => {
        try {
            let base64 = base64Data;
            if (base64.startsWith('data:image')) {
                const commaIndex = base64.indexOf(',');
                if (commaIndex !== -1) {
                    base64 = base64.substring(commaIndex + 1);
                }
            }
            const binaryString = atob(base64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            
            // Check for PNG
            const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
            const isPNG = pngSignature.every((byte, index) => bytes[index] === byte);
            if (isPNG) {
                const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
                const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
                resolve({ width, height, format: 'png' });
                return;
            }
            
            // Check for JPEG
            const jpegSignature = [0xFF, 0xD8, 0xFF];
            const isJPEG = jpegSignature.every((byte, index) => bytes[index] === byte);
            if (isJPEG) {
                resolve({ width: 512, height: 512, format: 'jpeg' });
                return;
            }
            
            resolve({ width: 512, height: 512, format: 'png' });
        } catch (error) {
            console.warn('Error detecting dimensions:', error);
            resolve({ width: 512, height: 512, format: 'png' });
        }
    });
}

/**
 * Base64 to ArrayBuffer conversion
 * Used to convert Base64 API image data into a Uint8Array for file system write.
 */
function convertBase64ToArrayBuffer(base64) {
    let binaryString;
    try {
        binaryString = atob(base64);
    } catch (e) {
        console.warn("Base64 decoding failed");
        return new Uint8Array(0); 
    }

    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes; 
}

// --- Photoshop Integration - Using app.open() and layer.duplicate() ---

/**
 * Saves a base64 image to a temp file, opens it in Photoshop, duplicates the layer
 * to the active document, and then cleans up the temp document and file.
 */
async function addImageToPhotoshop(imageData) {
    console.log('=== START addImageToPhotoshop (app.open method) ===');

    if (!photoshop.app.activeDocument) {
        throw new Error('No active document found. Please open a document in Photoshop first.');
    }

    const app = photoshop.app;
    const core = photoshop.core;

    let tempFile = null;
    let tempDoc = null;

    try {
        // STEP 1: Prepare image data
        console.log('STEP 1: Preparing image data...');
        let base64Data = imageData.split(',')[1];
        if (!base64Data) throw new Error("Invalid image data format");
        
        const uint8Array = convertBase64ToArrayBuffer(base64Data);
        if (uint8Array.byteLength === 0) throw new Error("Buffer is empty");
        
        const dimensions = await getImageDimensions(imageData);
        console.log(`Format: ${dimensions.format}, Size: ${uint8Array.byteLength} bytes`);

        // STEP 2: Write to temp file in data folder
        console.log('STEP 2: Writing to data folder...');
        const dataFolder = await localFileSystem.getDataFolder(); 
        const extension = dimensions.format === 'jpeg' ? 'jpg' : 'png';
        const fileName = `temp_generated_${Date.now()}.${extension}`; 
        
        tempFile = await dataFolder.createFile(fileName, { overwrite: true });
        await tempFile.write(uint8Array, { format: uxp.storage.formats.binary }); 
        console.log('Temp file written successfully');

        // STEP 3: Open the image and copy to active document
        console.log('STEP 3: Opening image and copying to active document...');
        
        const targetDoc = app.activeDocument;
        
        await core.executeAsModal(async () => {
            // Open the temp file as a new document
            tempDoc = await app.open(tempFile);
            console.log('Image opened as temp document');
            
            // Duplicate the background/first layer to the target document
            const layerToCopy = tempDoc.layers[0];
            await layerToCopy.duplicate(targetDoc);
            console.log('Layer duplicated to target document');
            
            // Close the temp document without saving
            await tempDoc.closeWithoutSaving();
            tempDoc = null;
            console.log('Temp document closed');
            
            // Set the active document back to the target
            app.activeDocument = targetDoc;
            
        }, { commandName: "Add Generated Image" });
        
        console.log('✅ Image successfully added to Photoshop!');

    } catch (error) {
        console.error('❌ Error:', error);
        console.error('Error details:', error.message);
        
        // Try to close temp document if it's still open
        if (tempDoc) {
            try {
                await tempDoc.closeWithoutSaving();
            } catch (e) {
                console.warn('Could not close temp document:', e.message);
            }
        }
        
        throw error;
    } finally {
        // Cleanup temp file
        if (tempFile) {
            try { 
                await new Promise(resolve => setTimeout(resolve, 1000));
                await tempFile.delete(); 
                console.log("Temp file cleaned up.");
            } catch (e) { 
                console.warn("Could not delete temp file:", e.message); 
            }
        }
    }
}


// --- Helper for bounds conversion (must be available globally in the file) ---


// --- Modified extractSelectionImage Function ---
/**
 * Extracts the pixel data from the active selection and returns it as an object
 * containing the raw Base64 string and the original selection bounds.
 * @returns {Promise<{base64Image: string, selectionBounds: {left: number, top: number, right: number, bottom: number}}>} 
 */
async function extractSelectionImage() {
    const statusDiv = document.getElementById('status-img2img');
    const logPrefix = "[extractSelectionImage]";
    
    if (!photoshop.app.activeDocument) {
        throw new Error('No active document open.');
    }

    let pixelData = null; 
    let selectionBounds = null; // Defined here to be accessible at the end

    try {
        // --- Selection Check (Robust DOM check) ---
        let hasSelection = false;
        const sel = photoshop.app.activeDocument.selection;
        
        try {
            if (sel && sel.bounds) hasSelection = true;
        } catch {
            hasSelection = false;
        }

        if (!hasSelection) {
            throw new Error("Please make a selection in the active document first.");
        }
        
        let base64Image = null;
        
        await core.executeAsModal(async () => {
            
            const selection = photoshop.app.activeDocument.selection;
            let boundsValue = selection.bounds;
            
            let left, top, right, bottom;
            
            if (Array.isArray(boundsValue) && boundsValue.length === 4) {
                // Scenario 1: Legacy Array of UnitValue objects
                [left, top, right, bottom] = boundsValue.map(safeAsPx);
                
            } else if (
                typeof boundsValue === 'object' &&
                ('left' in boundsValue || '_left' in boundsValue) // Check for properties
            ) {
                // Scenario 2: Newer Bounds object structure (or variant)
                left = safeAsPx(boundsValue.left || boundsValue._left);
                top = safeAsPx(boundsValue.top || boundsValue._top);
                right = safeAsPx(boundsValue.right || boundsValue._right);
                bottom = safeAsPx(boundsValue.bottom || boundsValue._bottom);
            } else {
                throw new Error("Selection bounds structure is invalid. Please try a simple rectangular selection.");
            }

            selectionBounds = { left, top, right, bottom }; // <<< Selection bounds captured here

            const width = right - left;
            const height = bottom - top;

            if (width <= 0 || height <= 0) {
                throw new Error("The active selection must have a width and height greater than zero.");
            }

            // --- Extract pixels using imaging.getPixels ---
            statusDiv.textContent = 'Extracting pixels...';
            
            pixelData = await imaging.getPixels({
                documentID: photoshop.app.activeDocument.id,
                sourceBounds: selectionBounds,
                colorSpace: "RGB", 
                componentSize: 8,
                applyAlpha: true
            });

            // --- Encode Base64 using imaging.encodeImageData ---
            statusDiv.textContent = 'Encoding image data...';
            
            base64Image = await imaging.encodeImageData({
                "imageData": pixelData.imageData, 
                "base64": true,
                "outputFormat": "png"
            });
            
        }, { commandName: "Extract Selection Image" });

        // RETURN BOTH IMAGE DATA AND BOUNDS
        return { base64Image, selectionBounds };

    } catch (error) {
        console.error(`${logPrefix} ❌ Error during selection extraction:`, error);
        throw error;
    } finally {
        if (pixelData?.imageData?.dispose) {
            pixelData.imageData.dispose();
            console.log(`${logPrefix} 🧹 Memory cleanup done.`);
        }
    }
}
// --- Helper for consistent pixel conversion ---
const safeAsPx = (v) => {
    if (typeof v === "object" && v !== null && typeof v.as === "function") {
        return v.as("px");
    }
    return Number(v);
};
// --- Helper: safely read layer bounds as pixels ---
// --- Helper: safely read layer bounds as pixels ---
// --- Helper: safely read layer bounds as pixels ---
function getLayerBounds(layer) {
    const lb = layer.bounds;
    let left, top, right, bottom;

    if (Array.isArray(lb) && lb.length === 4) {
        [left, top, right, bottom] = lb.map(v => (v.as ? v.as("px") : Number(v)));
    } else if (lb && typeof lb === "object") {
        left = lb.left?.as ? lb.left.as("px") : lb.left ?? lb._left ?? 0;
        top = lb.top?.as ? lb.top.as("px") : lb.top ?? lb._top ?? 0;
        right = lb.right?.as ? lb.right.as("px") : lb.right ?? lb._right ?? 0;
        bottom = lb.bottom?.as ? lb.bottom.as("px") : lb.bottom ?? lb._bottom ?? 0;
    } else {
        left = top = right = bottom = 0;
    }

    return { left, top, right, bottom };
}

// // --- Main function ---
// async function addImageToPhotoshopWithTransform(imageData, targetBounds) {
//     const logPrefix = "[addImageToPhotoshopWithTransform]";
//     console.log(`${logPrefix} === START ===`);

//     if (!photoshop.app.activeDocument) {
//         throw new Error('No active document found. Please open a document in Photoshop first.');
//     }

//     const app = photoshop.app;
//     const core = photoshop.core;
//     const action = photoshop.action;
//     const localFS = localFileSystem;

//     let tempFile = null;
//     let tempDoc = null;

//     try {
//         // --- Step 1: Prepare image ---
//         let base64Data = imageData.split(',')[1];
//         if (!base64Data) throw new Error("Invalid image data format");

//         const uint8Array = convertBase64ToArrayBuffer(base64Data);
//         const dimensions = await getImageDimensions(imageData); // {width, height, format}
//         console.log(`${logPrefix} 🖼️ Generated image dimensions:`, dimensions);

//         const dataFolder = await localFS.getDataFolder();
//         const extension = dimensions.format === 'jpeg' ? 'jpg' : 'png';
//         const fileName = `temp_generated_${Date.now()}.${extension}`;
//         tempFile = await dataFolder.createFile(fileName, { overwrite: true });
//         await tempFile.write(uint8Array, { format: uxp.storage.formats.binary });
//         console.log(`${logPrefix} 💾 Temp image written to: ${tempFile.nativePath}`);

//         const targetDoc = app.activeDocument;

//         // --- Step 2: Execute Photoshop actions ---
//         await core.executeAsModal(async () => {
//             console.log(`${logPrefix} 🔒 Entered executeAsModal`);

//             // Open temp image
//             tempDoc = await app.open(tempFile);
//             console.log(`${logPrefix} 🆕 Temp document opened. Layers: ${tempDoc.layers.length}`);

//             // Duplicate to target
//             const newLayer = await tempDoc.layers[0].duplicate(targetDoc);
//             console.log(`${logPrefix} ✅ Layer duplicated to target doc: ${targetDoc.title}`);

//             // Close temp doc
//             await tempDoc.closeWithoutSaving();
//             tempDoc = null;
//             app.activeDocument = targetDoc;
//             targetDoc.activeLayers = [newLayer];

//             // --- Step 3: Deselect any active selection ---
//             console.log(`${logPrefix} ✂️ Deselecting current selection to allow free transform...`);
//             try {
//                 targetDoc.selection.deselect();
//                 console.log(`${logPrefix} ✅ Selection cleared.`);
//             } catch (e) {
//                 console.warn(`${logPrefix} ⚠️ Could not deselect selection:`, e.message);
//             }

//             // --- Step 4: Get original layer bounds ---
//             const { left, top, right, bottom } = getLayerBounds(newLayer);
//             const initW = right - left;
//             const initH = bottom - top;
//             console.log(`${logPrefix} 📏 Original layer size: ${initW} x ${initH}`);
//             console.log(`${logPrefix} 📍 Original layer position: left=${left}, top=${top}`);

//             // --- Step 5: Target selection size and center ---
//             const selW = targetBounds.right - targetBounds.left;
//             const selH = targetBounds.bottom - targetBounds.top;
//             const targetCenterX = targetBounds.left + selW / 2;
//             const targetCenterY = targetBounds.top + selH / 2;
//             console.log(`${logPrefix} 🎯 Target selection size: ${selW} x ${selH}`);
//             console.log(`${logPrefix} 🎯 Target center: (${targetCenterX}, ${targetCenterY})`);

//             // --- Step 6: Apply absolute pixel transform ---
//             const transformDesc = {
//                 _obj: "transform",
//                 _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
//                 freeTransform: true,
//                 linked: true,
//                 width: { _unit: "pixelsUnit", _value: selW },
//                 height: { _unit: "pixelsUnit", _value: selH },
//                 to: {
//                     _obj: "point",
//                     horizontal: { _unit: "pixelsUnit", _value: targetCenterX },
//                     vertical: { _unit: "pixelsUnit", _value: targetCenterY }
//                 },
//                 center: {
//                     _obj: "point",
//                     horizontal: { _unit: "pixelsUnit", _value: left + initW / 2 },
//                     vertical: { _unit: "pixelsUnit", _value: top + initH / 2 }
//                 }
//             };

//             await action.batchPlay([transformDesc], {});
//             console.log(`${logPrefix} 🔧 Transform executed.`);

//             // --- Step 7: Verify final bounds ---
//             const finalBounds = getLayerBounds(newLayer);
//             const finalW = finalBounds.right - finalBounds.left;
//             const finalH = finalBounds.bottom - finalBounds.top;
//             const finalCenterX = finalBounds.left + finalW / 2;
//             const finalCenterY = finalBounds.top + finalH / 2;

//             console.log(`${logPrefix} ✅ Final layer bounds:`, finalBounds);
//             console.log(`${logPrefix} ✅ Final size: ${finalW} x ${finalH}`);
//             console.log(`${logPrefix} ✅ Final center: (${finalCenterX.toFixed(1)}, ${finalCenterY.toFixed(1)})`);

//         }, { commandName: "Add and Transform Generated Image" });

//         console.log(`${logPrefix} ✅ Image added and transformed successfully.`);

//     } catch (error) {
//         console.error(`${logPrefix} ❌ Error:`, error);
//         if (tempDoc) try { await tempDoc.closeWithoutSaving(); } catch {}
//         throw error;

//     } finally {
//         if (tempFile) {
//             try {
//                 await new Promise(resolve => setTimeout(resolve, 500));
//                 await tempFile.delete();
//                 console.log(`${logPrefix} 🧹 Temp file cleaned up.`);
//             } catch (e) {
//                 console.warn(`${logPrefix} ⚠️ Could not delete temp file: ${e.message}`);
//             }
//         }
//     }
// }
// --- Main function: Transform generated image to match selection bounds ---
// --- Main function: Transform generated image to match selection bounds ---
async function addImageToPhotoshopWithTransform(imageData, targetBounds) {
    const logPrefix = "[addImageToPhotoshopWithTransform]";
    console.log(`${logPrefix} === START ===`);

    if (!photoshop.app.activeDocument) {
        throw new Error('No active document found. Please open a document in Photoshop first.');
    }

    const app = photoshop.app;
    const core = photoshop.core;
    const action = photoshop.action;
    const localFS = localFileSystem;

    let tempFile = null;
    let tempDoc = null;

    try {
        // --- Step 1: Prepare image ---
        let base64Data = imageData.split(',')[1];
        if (!base64Data) throw new Error("Invalid image data format");

        const uint8Array = convertBase64ToArrayBuffer(base64Data);
        const dimensions = await getImageDimensions(imageData); // {width, height, format}
        console.log(`${logPrefix} 🖼️ Generated image dimensions:`, dimensions);

        const dataFolder = await localFS.getDataFolder();
        const extension = dimensions.format === 'jpeg' ? 'jpg' : 'png';
        const fileName = `temp_generated_${Date.now()}.${extension}`;
        tempFile = await dataFolder.createFile(fileName, { overwrite: true });
        await tempFile.write(uint8Array, { format: uxp.storage.formats.binary });
        console.log(`${logPrefix} 💾 Temp image written to: ${tempFile.nativePath}`);

        const targetDoc = app.activeDocument;

        // --- Step 2: Execute Photoshop actions ---
        await core.executeAsModal(async () => {
            console.log(`${logPrefix} 🔒 Entered executeAsModal`);

            // Open temp image and duplicate as smart object
            tempDoc = await app.open(tempFile);
            console.log(`${logPrefix} 🆕 Temp document opened. Layers: ${tempDoc.layers.length}`);

            // Duplicate to target as a smart object
            const newLayer = await tempDoc.layers[0].duplicate(targetDoc);
            console.log(`${logPrefix} ✅ Layer duplicated to target doc: ${targetDoc.title}`);

            // Close temp doc
            await tempDoc.closeWithoutSaving();
            tempDoc = null;
            app.activeDocument = targetDoc;
            targetDoc.activeLayers = [newLayer];

            // Deselect any active selection to allow free transform
            console.log(`${logPrefix} ✂️ Deselecting current selection to allow free transform...`);
            try {
                targetDoc.selection.deselect();
                console.log(`${logPrefix} ✅ Selection cleared.`);
            } catch (e) {
                console.warn(`${logPrefix} ⚠️ Could not deselect selection:`, e.message);
            }

            // Convert to Smart Object FIRST (using UXP batchPlay API)
            console.log(`${logPrefix} 🔧 Converting to Smart Object...`);
            const smartObjectDesc = {
                _obj: "newPlacedLayer"
            };
            await action.batchPlay([smartObjectDesc], {});
            console.log(`${logPrefix} ✅ Layer converted to Smart Object`);

            // Get fresh reference to the layer (Smart Object conversion creates a new layer)
            const smartLayer = targetDoc.activeLayers[0];
            console.log(`${logPrefix} 🔄 Got fresh layer reference after Smart Object conversion`);

            // Get original layer bounds
            const { left, top, right, bottom } = getLayerBounds(smartLayer);
            const initW = right - left;
            const initH = bottom - top;
            console.log(`${logPrefix} 📏 Original layer size: ${initW} x ${initH}`);
            console.log(`${logPrefix} 📍 Original layer position: left=${left}, top=${top}`);

            // Calculate target dimensions
            const selW = targetBounds.right - targetBounds.left;
            const selH = targetBounds.bottom - targetBounds.top;
            const targetCenterX = targetBounds.left + selW / 2;
            const targetCenterY = targetBounds.top + selH / 2;
            console.log(`${logPrefix} 🎯 Target selection size: ${selW} x ${selH}`);
            console.log(`${logPrefix} 🎯 Target center: (${targetCenterX}, ${targetCenterY})`);

            // Calculate scale to match selection size (preserving aspect ratio)
            const scaleX = (selW / initW) * 100;
            const scaleY = (selH / initH) * 100;
            
            console.log(`${logPrefix} 📐 Scale factors: X=${scaleX.toFixed(2)}%, Y=${scaleY.toFixed(2)}%`);

            // Apply scale transformation
            const transformDesc = {
                _obj: "transform",
                _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
                freeTransform: true,
                width: { _unit: "percentUnit", _value: scaleX },
                height: { _unit: "percentUnit", _value: scaleY }
            };

            await action.batchPlay([transformDesc], {});
            console.log(`${logPrefix} 🔧 Scale transform executed.`);

            // Calculate position offset and translate
            // Get the layer bounds after scaling
            const scaledBounds = getLayerBounds(smartLayer);
            const scaledCenterX = scaledBounds.left + (scaledBounds.right - scaledBounds.left) / 2;
            const scaledCenterY = scaledBounds.top + (scaledBounds.bottom - scaledBounds.top) / 2;
            
            console.log(`${logPrefix} 📍 Scaled layer center: (${scaledCenterX.toFixed(2)}, ${scaledCenterY.toFixed(2)})`);
            console.log(`${logPrefix} 🎯 Target center: (${targetCenterX.toFixed(2)}, ${targetCenterY.toFixed(2)})`);
            
            // Calculate offset needed to move to target position
            const offsetX = targetCenterX - scaledCenterX;
            const offsetY = targetCenterY - scaledCenterY;
            
            console.log(`${logPrefix} ➡️ Translation offset: X=${offsetX.toFixed(2)}px, Y=${offsetY.toFixed(2)}px`);
            
            // Translate the layer to the target position
            if (offsetX !== 0 || offsetY !== 0) {
                await smartLayer.translate(offsetX, offsetY);
                console.log(`${logPrefix} 🔧 Layer translated to target position.`);
            } else {
                console.log(`${logPrefix} ℹ️ No translation needed, layer already at target position.`);
            }

            // Verify final bounds and position
            const finalBounds = getLayerBounds(smartLayer);
            const finalW = finalBounds.right - finalBounds.left;
            const finalH = finalBounds.bottom - finalBounds.top;
            const finalCenterX = finalBounds.left + finalW / 2;
            const finalCenterY = finalBounds.top + finalH / 2;

            console.log(`${logPrefix} ✅ Final layer bounds:`, finalBounds);
            console.log(`${logPrefix} ✅ Final size: ${finalW.toFixed(1)} x ${finalH.toFixed(1)}`);
            console.log(`${logPrefix} ✅ Final center: (${finalCenterX.toFixed(1)}, ${finalCenterY.toFixed(1)})`);
            console.log(`${logPrefix} ✅ Expected size: ${selW} x ${selH}`);

            // Bring layer to front
            await smartLayer.bringToFront();
            console.log(`${logPrefix} ⬆️ Layer brought to front`);

        }, { commandName: "Add and Transform Generated Image" });

        console.log(`${logPrefix} ✅ Image added and transformed successfully.`);

    } catch (error) {
        console.error(`${logPrefix} ❌ Error:`, error);
        if (tempDoc) try { await tempDoc.closeWithoutSaving(); } catch {}
        throw error;

    } finally {
        if (tempFile) {
            try {
                await new Promise(resolve => setTimeout(resolve, 500));
                await tempFile.delete();
                console.log(`${logPrefix} 🧹 Temp file cleaned up.`);
            } catch (e) {
                console.warn(`${logPrefix} ⚠️ Could not delete temp file: ${e.message}`);
            }
        }
    }
}
// --- Modified imageToImageGenerate Function ---
async function imageToImageGenerate() {
    const logPrefix = "[imageToImageGenerate]";
    console.log(`${logPrefix} 🚀 Function called`);
    
    // Get DOM elements
    const apiKeyElement = document.getElementById('openrouter-api-key-input');
    const promptElement = document.getElementById('prompt-img2img');
    const img2imgBtn = document.getElementById('img2img-btn');
    const previewImg = document.getElementById('generated-image');
    const statusDiv = document.getElementById('status-img2img');
    
    console.log(`${logPrefix} 📍 DOM Elements:`, {
        apiKeyElement: apiKeyElement ? '✅ Found' : '❌ NULL',
        promptElement: promptElement ? '✅ Found' : '❌ NULL',
        img2imgBtn: img2imgBtn ? '✅ Found' : '❌ NULL',
        previewImg: previewImg ? '✅ Found' : '❌ NULL',
        statusDiv: statusDiv ? '✅ Found' : '❌ NULL'
    });
    
    // Check for critical null elements
    if (!statusDiv) {
        console.error(`${logPrefix} ❌ CRITICAL: status-img2img element not found in DOM`);
        alert('UI Error: Status display element not found.');
        return;
    }
    
    if (!img2imgBtn) {
        console.error(`${logPrefix} ❌ CRITICAL: img2img-btn element not found in DOM`);
        statusDiv.textContent = '❌ Button not found.';
        return;
    }
    
    // Get values safely
    let apiKey, prompt;
    try {
        const rawApiKey = apiKeyElement?.value;
        apiKey = (rawApiKey !== null && rawApiKey !== undefined) ? String(rawApiKey).trim() : '';
        console.log(`${logPrefix} API key retrieved:`, apiKey ? 'YES (length: ' + apiKey.length + ')' : 'NO/EMPTY');
    } catch (e) {
        console.error(`${logPrefix} ❌ Error getting API key:`, e);
        apiKey = '';
    }
    
    try {
        const rawPrompt = promptElement?.value;
        prompt = (rawPrompt !== null && rawPrompt !== undefined) ? String(rawPrompt).trim() : '';
        console.log(`${logPrefix} Prompt retrieved:`, prompt ? 'YES (length: ' + prompt.length + ')' : 'NO/EMPTY');
    } catch (e) {
        console.error(`${logPrefix} ❌ Error getting prompt:`, e);
        prompt = '';
    }

    // Validation
    if (!apiKey) {
        console.log(`${logPrefix} ⚠️ No API key provided`);
        statusDiv.textContent = '❌ Please enter your OpenRouter API key in Settings';
        alert('Please enter your OpenRouter API key in the Settings tab');
        return;
    }

    if (!prompt) {
        console.log(`${logPrefix} ⚠️ No prompt provided`);
        alert('Please enter a transformation prompt');
        return;
    }

    console.log(`${logPrefix} ✅ Validations passed, starting generation...`);

    let finalImageUrl = null;
    let originalSelectionBounds = null;
    
    try {
        // Update UI
        console.log(`${logPrefix} 🔄 Updating UI...`);
        img2imgBtn.disabled = true;
        img2imgBtn.textContent = 'Processing...';

        // 1. Extract the selected image as Base64 and capture bounds
        console.log(`${logPrefix} 🖼️ Step 1: Extracting selection...`);
        statusDiv.textContent = '1/3. Extracting selected image...';
        const extractionResult = await extractSelectionImage();
        const inputImageBase64 = extractionResult.base64Image;
        originalSelectionBounds = extractionResult.selectionBounds;
        console.log(`${logPrefix} ✅ Selection extracted, bounds:`, originalSelectionBounds);
        
        // 2. Prepare the API call
        console.log(`${logPrefix} 🌐 Step 2: Preparing API request...`);
        statusDiv.textContent = '2/3. Sending request to OpenRouter API...';
        
        const inputImageUrl = `data:image/png;base64,${inputImageBase64}`;
        console.log(`${logPrefix} 📦 Image data length:`, inputImageBase64.length);

        // Get the image model from settings
        const imageModelInput = document.getElementById('setting-image-model');
        const imageModel = imageModelInput?.value || 'google/gemini-2.5-flash-image';
        console.log(`${logPrefix} 🤖 Using model:`, imageModel);
        
        const requestBody = {
            model: imageModel,
            modalities: ["image", "text"],
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: "text", text: prompt },
                        { 
                            type: "image_url", 
                            image_url: { url: inputImageUrl } 
                        }
                    ]
                }
            ]
        };
        
        console.log(`${logPrefix} 📤 Sending request to API...`);
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        console.log(`${logPrefix} 📥 Response received:`, {
            status: response.status,
            statusText: response.statusText,
            ok: response.ok
        });

        // Check response status
        if (!response.ok) {
            console.error(`${logPrefix} ❌ API request failed`);
            const errorData = await response.json().catch(() => ({}));
            console.error(`${logPrefix} ❌ Error data:`, errorData);
            const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
            throw new Error(`API Error: ${errorMessage}`);
        }

        console.log(`${logPrefix} 🔄 Processing response...`);
        statusDiv.textContent = '2/3. Processing API response...';
        const data = await response.json();
        console.log(`${logPrefix} 📦 Response data:`, data);
        
        // 3. Extract the generated image URL from the response
        if (data.choices && data.choices[0] && data.choices[0].message) {
            const message = data.choices[0].message;
            console.log(`${logPrefix} 📨 Message received:`, message);
            
            if (message.images && message.images[0] && message.images[0].image_url) {
                finalImageUrl = message.images[0].image_url.url;
                console.log(`${logPrefix} ✅ Image URL extracted from message.images`);
            } else if (Array.isArray(message.content)) {
                console.log(`${logPrefix} 🔍 Checking content array...`);
                for (const item of message.content) {
                    if (item.type === 'image_url' && item.image_url && item.image_url.url) {
                        finalImageUrl = item.image_url.url;
                        console.log(`${logPrefix} ✅ Image URL extracted from content array`);
                        break;
                    }
                }
            } else if (typeof message.content === 'string' && message.content.startsWith('data:image')) {
                finalImageUrl = message.content;
                console.log(`${logPrefix} ✅ Image URL extracted from string content`);
            }

            if (!finalImageUrl) {
                console.error(`${logPrefix} ❌ No image URL found in response`);
                console.error(`${logPrefix} Full response:`, JSON.stringify(data, null, 2));
                throw new Error('No image data found in API response. Check console for details.');
            }
            
            console.log(`${logPrefix} 🖼️ Image URL length:`, finalImageUrl.length);
            
            // Display preview 
            if (previewImg) {
                console.log(`${logPrefix} 🔄 Setting preview...`);
                previewImg.src = finalImageUrl;
                previewImg.style.display = 'block';
            }
            
            // 4. Add the generated image to Photoshop and TRANSFORM
            console.log(`${logPrefix} 🔄 Step 3: Adding to Photoshop...`);
            statusDiv.textContent = '3/3. Adding and transforming in Photoshop...';
            await addImageToPhotoshopWithTransform(finalImageUrl, originalSelectionBounds);
            console.log(`${logPrefix} ✅ Image added and transformed successfully`);

            statusDiv.textContent = '✅ Success! Image added and transformed';

        } else {
            console.error(`${logPrefix} ❌ Invalid response structure`);
            console.error(`${logPrefix} Full response:`, JSON.stringify(data, null, 2));
            throw new Error('Invalid API response format: missing choices or message');
        }

    } catch (error) {
        console.error(`${logPrefix} ❌ Error caught:`, error);
        console.error(`${logPrefix} ❌ Error type:`, error.constructor.name);
        console.error(`${logPrefix} ❌ Error message:`, error.message);
        console.error(`${logPrefix} ❌ Error stack:`, error.stack);
        
        statusDiv.textContent = `❌ Error: ${error.message}`;
        alert(`Error generating image:\n\n${error.message}`);
    } finally {
        console.log(`${logPrefix} 🔄 Restoring UI...`);
        img2imgBtn.disabled = false;
        img2imgBtn.textContent = 'Generate Inpainting';
        console.log(`${logPrefix} 🏁 Function complete`);
    }
}

// --- Corrected scaleSelectionByPercent Function ---
async function scaleSelectionByPercent() {
    const logPrefix = "[scaleSelectionByPercent]";
    console.log(`${logPrefix} 🚀 Function called`);
    
    const statusDiv = document.getElementById('status-modify');
    const scaleSlider = document.getElementById('scale-slider');
    
    console.log(`${logPrefix} 📍 DOM Elements:`, {
        statusDiv: statusDiv ? '✅ Found' : '❌ NULL',
        scaleSlider: scaleSlider ? '✅ Found' : '❌ NULL'
    });
    
    if (!statusDiv) {
        console.error(`${logPrefix} ❌ CRITICAL: status-modify element not found in DOM`);
        return;
    }
    
    if (!scaleSlider) {
        console.error(`${logPrefix} ❌ CRITICAL: scale-slider element not found in DOM`);
        statusDiv.textContent = '❌ Scale slider not found.';
        return;
    }
    
    if (!app.activeDocument) {
        console.log(`${logPrefix} ⚠️ No active document`);
        statusDiv.textContent = '❌ No active document open.';
        return;
    }
    
    const scalePercent = parseInt(scaleSlider.value, 10);
    const scaleFactor = 1 + (scalePercent / 100);
    console.log(`${logPrefix} 📊 Scale settings:`, { scalePercent, scaleFactor });

    try {
        console.log(`${logPrefix} ⏳ Starting executeAsModal...`);
        await core.executeAsModal(async () => {
            console.log(`${logPrefix} 🔓 Inside executeAsModal`);
            
            const doc = app.activeDocument;
            const selection = doc.selection;
            console.log(`${logPrefix} 📄 Document and selection objects obtained`);

            // 1. Check for active selection (robust check)
            try {
                if (!selection.bounds) {
                    throw new Error("No active selection to scale. Please create one first.");
                }
                console.log(`${logPrefix} ✅ Selection bounds exist`);
            } catch (e) {
                console.error(`${logPrefix} ❌ No selection bounds:`, e);
                throw new Error("No active selection to scale. Please create one first.");
            }

            // 2. Read current selection bounds (using the robust conversion)
            const bnds = selection.bounds;
            console.log(`${logPrefix} 📐 Raw bounds:`, bnds);
            console.log(`${logPrefix} 📐 Bounds type:`, typeof bnds, Array.isArray(bnds) ? 'Array' : 'Object');

            let left, top, right, bottom;

            // CRITICAL FIX: The bounds array contains UnitValue objects, which must be mapped/converted.
            if (Array.isArray(bnds) && bnds.length === 4) {
                console.log(`${logPrefix} 🔄 Processing as Array of UnitValues`);
                [left, top, right, bottom] = bnds.map(safeAsPx);
            } else if (
                typeof bnds === 'object' &&
                ('left' in bnds || '_left' in bnds)
            ) {
                console.log(`${logPrefix} 🔄 Processing as Bounds object`);
                left = safeAsPx(bnds.left || bnds._left);
                top = safeAsPx(bnds.top || bnds._top);
                right = safeAsPx(bnds.right || bnds._right);
                bottom = safeAsPx(bnds.bottom || bnds._bottom);
            } else {
                console.error(`${logPrefix} ❌ Invalid bounds structure:`, bnds);
                throw new Error("Selection bounds structure is invalid for scaling.");
            }
            
            console.log(`${logPrefix} 📏 Converted bounds (px):`, { left, top, right, bottom });
            
            const currentWidth = right - left;
            const currentHeight = bottom - top;
            console.log(`${logPrefix} 📏 Current dimensions:`, { currentWidth, currentHeight });

            if (currentWidth <= 0 || currentHeight <= 0) {
                console.error(`${logPrefix} ❌ Zero area selection`);
                throw new Error("Selection has zero area. Please make a valid selection.");
            }

            // 3. Calculate new dimensions and center
            const centerX = left + currentWidth / 2;
            const centerY = top + currentHeight / 2;
            console.log(`${logPrefix} 🎯 Center point:`, { centerX, centerY });
            
            const newWidth = currentWidth * scaleFactor;
            const newHeight = currentHeight * scaleFactor;
            console.log(`${logPrefix} 📏 New dimensions:`, { newWidth, newHeight });

            // 4. Calculate new top/left/bottom/right coordinates
            const newLeft = centerX - newWidth / 2;
            const newTop = centerY - newHeight / 2;
            const newRight = centerX + newWidth / 2;
            const newBottom = centerY + newHeight / 2;
            console.log(`${logPrefix} 📐 New bounds (pre-round):`, { newLeft, newTop, newRight, newBottom });

            // 5. Apply the new selection (rounding for integer pixels)
            const newBounds = {
                top: Math.round(newTop),
                left: Math.round(newLeft),
                bottom: Math.round(newBottom),
                right: Math.round(newRight)
            };
            console.log(`${logPrefix} 📐 Final bounds (rounded):`, newBounds);
            
            // 6. Check for out-of-bounds warning
            const docWidth = doc.width;
            const docHeight = doc.height;
            console.log(`${logPrefix} 📄 Document size:`, { docWidth, docHeight });
            
            const isOutOfBounds = newLeft < 0 || newTop < 0 || newRight > docWidth || newBottom > docHeight;
            console.log(`${logPrefix} ⚠️ Out of bounds check:`, { isOutOfBounds, scaleFactor });

            if (isOutOfBounds && scaleFactor > 1) {
                console.log(`${logPrefix} ⚠️ Selection expanded beyond canvas`);
                statusDiv.textContent = `⚠️ Expanded beyond canvas! Generated image may not fit.`;
            } else {
                console.log(`${logPrefix} ✅ Selection within canvas bounds`);
                statusDiv.textContent = `Scaling selection by ${scalePercent}%.`;
            }
            
            // Apply the final selection
            console.log(`${logPrefix} 🔄 Applying selectRectangle...`);
            await selection.selectRectangle(
                newBounds,
                constants.SelectionType.REPLACE,
                0 
            );
            console.log(`${logPrefix} ✅ selectRectangle completed`);
            
            // Force Marquee Tool Visual
            console.log(`${logPrefix} 🔄 Switching to Marquee Tool...`);
            await action.batchPlay([
                {
                    _obj: "select",
                    _target: [ { _ref: "tool", _name: "Rectangular Marquee Tool" } ]
                }
            ], {});
            console.log(`${logPrefix} ✅ Marquee Tool activated`);

        }, { commandName: "Scale Selection by Percent" });
        
        console.log(`${logPrefix} ✅ executeAsModal completed successfully`);
        
        // Final UI update after modal
        const scaleValueDiv = document.getElementById('scale-value');
        console.log(`${logPrefix} 📍 scale-value element:`, scaleValueDiv ? '✅ Found' : '❌ NULL');
        if (scaleValueDiv) {
            scaleValueDiv.textContent = `${scalePercent}%`;
            console.log(`${logPrefix} ✅ Updated scale-value display`);
        }

    } catch (error) {
        console.error(`${logPrefix} ❌ Error caught:`, error);
        console.error(`${logPrefix} ❌ Error type:`, error.constructor.name);
        console.error(`${logPrefix} ❌ Error message:`, error.message);
        console.error(`${logPrefix} ❌ Error stack:`, error.stack);
        
        // Custom error handling for clarity
        let errorMsg = error.message || error;
        if (errorMsg.includes("not a function") || errorMsg.includes("Cannot read properties")) {
            console.log(`${logPrefix} 🔄 Converting to user-friendly message`);
            errorMsg = "Invalid selection state. Please try making a new selection first.";
        }
        statusDiv.textContent = `❌ Error: ${errorMsg}`;
        console.log(`${logPrefix} 📝 Status message set to:`, statusDiv.textContent);
    }
    
    console.log(`${logPrefix} 🏁 Function complete`);
}

async function addSelectionToDocument() {
    const logPrefix = "[addSelectionToDocument]";
    console.log(`${logPrefix} 🚀 Function called`);
    
    const statusDiv = document.getElementById('status-selection');
    const selectElement = document.getElementById('aspect-ratio-select');
    
    console.log(`${logPrefix} 📍 DOM Elements:`, {
        statusDiv: statusDiv ? '✅ Found' : '❌ NULL',
        selectElement: selectElement ? '✅ Found' : '❌ NULL'
    });
    
    if (!statusDiv) {
        console.error(`${logPrefix} ❌ CRITICAL: status-selection element not found in DOM`);
        return;
    }
    
    if (!selectElement) {
        console.error(`${logPrefix} ❌ CRITICAL: aspect-ratio-select element not found in DOM`);
        statusDiv.textContent = '❌ Aspect ratio selector not found.';
        return;
    }
    
    statusDiv.textContent = 'Preparing selection...';
    console.log(`${logPrefix} 📝 Status set to: Preparing selection...`);

    if (!app.activeDocument) {
        console.log(`${logPrefix} ⚠️ No active document`);
        statusDiv.textContent = '❌ No active document open.';
        return;
    }

    const constants = window.require('photoshop').constants;
    console.log(`${logPrefix} ✅ Constants loaded`);

    try {
        const selectedIndex = selectElement.value;
        console.log(`${logPrefix} 📊 Selected aspect ratio index:`, selectedIndex);
        
        const selectedRatio = SUPPORTED_ASPECT_RATIOS[selectedIndex];
        console.log(`${logPrefix} 📊 Selected ratio object:`, selectedRatio);

        if (!selectedRatio) {
            console.error(`${logPrefix} ❌ Invalid aspect ratio index: ${selectedIndex}`);
            throw new Error("Invalid aspect ratio selected.");
        }

        console.log(`${logPrefix} ⏳ Starting executeAsModal...`);
        await core.executeAsModal(async () => {
            console.log(`${logPrefix} 🔓 Inside executeAsModal`);
            const doc = app.activeDocument;

            // 1️⃣ Get document dimensions
            const docWidth = doc.width;
            const docHeight = doc.height;
            console.log(`${logPrefix} 📄 Document size: ${docWidth}x${docHeight} px`);

            // 2️⃣ Compute aspect-ratio-based selection size
            const ratio = selectedRatio.ratio;
            console.log(`${logPrefix} 📐 Target aspect ratio:`, ratio, `(${selectedRatio.name})`);
            
            let selectionWidth, selectionHeight;

            if (docWidth / docHeight > ratio) {
                // Fit by height
                selectionHeight = docHeight;
                selectionWidth = docHeight * ratio;
                console.log(`${logPrefix} 🔄 Fitting by HEIGHT`);
            } else {
                // Fit by width
                selectionWidth = docWidth;
                selectionHeight = docWidth / ratio;
                console.log(`${logPrefix} 🔄 Fitting by WIDTH`);
            }
            console.log(`${logPrefix} 📏 Initial dimensions:`, { selectionWidth, selectionHeight });

            // Optional: scale selection to add margin
            const scale = 0.9;
            selectionWidth *= scale;
            selectionHeight *= scale;
            console.log(`${logPrefix} 📏 After ${scale * 100}% scale:`, { selectionWidth, selectionHeight });

            // 3️⃣ Compute centered position
            let left = (docWidth - selectionWidth) / 2;
            let top = (docHeight - selectionHeight) / 2;
            let right = left + selectionWidth;
            let bottom = top + selectionHeight;
            console.log(`${logPrefix} 📐 Centered position (pre-clamp):`, { left, top, right, bottom });

            // 4️⃣ Adjust to ensure the selection is fully inside the canvas
            const bounds = {
                top: Math.max(0, Math.round(top)),
                left: Math.max(0, Math.round(left)),
                bottom: Math.min(docHeight, Math.round(bottom)),
                right: Math.min(docWidth, Math.round(right))
            };
            console.log(`${logPrefix} 📐 Final bounds (clamped & rounded):`, bounds);

            // 5️⃣ Recalculate the actual used selection size (after clipping)
            const adjustedWidth = bounds.right - bounds.left;
            const adjustedHeight = bounds.bottom - bounds.top;
            console.log(`${logPrefix} 📏 Final selection size:`, { adjustedWidth, adjustedHeight });

            if (adjustedWidth <= 0 || adjustedHeight <= 0) {
                console.error(`${logPrefix} ❌ Invalid bounds after clipping`);
                throw new Error("Selection bounds are invalid or outside the canvas.");
            }

            // 6️⃣ Apply the final adjusted selection
            console.log(`${logPrefix} 🔄 Applying selectRectangle...`);
            await doc.selection.selectRectangle(
                bounds,
                constants.SelectionType.REPLACE,
                0
            );
            console.log(`${logPrefix} ✅ Selection applied successfully`);

            const successMsg = `✅ ${selectedRatio.name} selection created (${adjustedWidth}x${adjustedHeight})`;
            statusDiv.textContent = successMsg;
            console.log(`${logPrefix} 📝 Status updated:`, successMsg);

        }, { commandName: "Add Predefined Selection" });
        
        console.log(`${logPrefix} ✅ executeAsModal completed successfully`);

    } catch (error) {
        console.error(`${logPrefix} ❌ Error caught:`, error);
        console.error(`${logPrefix} ❌ Error type:`, error.constructor.name);
        console.error(`${logPrefix} ❌ Error message:`, error.message);
        console.error(`${logPrefix} ❌ Error stack:`, error.stack);
        
        const errorMsg = error.message || 'Unknown error occurred';
        statusDiv.textContent = `❌ Error: ${errorMsg}`;
        console.log(`${logPrefix} 📝 Status message set to:`, statusDiv.textContent);
    }
    
    console.log(`${logPrefix} 🏁 Function complete`);
}
// --- NEW Function: Modify Selection (Contract/Expand) ---


// async function generateImage() {
//     console.log('[generateImage] 🚀 Function called');
//     const apiKey = document.getElementById('api-key').value.trim();
//     const prompt = document.getElementById('prompt').value.trim();
//     const generateBtn = document.getElementById('generate-btn');
//     const previewImg = document.getElementById('generated-image');
//     const statusDiv = document.getElementById('status');

//     // Validation
//     if (!apiKey) {
//         alert('Please enter your OpenRouter API key');
//         return;
//     }

//     if (!prompt) {
//         alert('Please enter an image prompt');
//         return;
//     }

//     try {
//         // Update UI
//         generateBtn.disabled = true;
//         generateBtn.textContent = 'Generating...';
//         statusDiv.textContent = 'Sending request to OpenRouter API...';
        
//         // Get selected aspect ratio from dropdown
//         const imageSizeSelect = document.getElementById('image-size-select');
//         const selectedRatioName = imageSizeSelect.value;
        
//         const requestBody = {
//             model: 'google/gemini-2.5-flash-image-preview',
//             messages: [
//                 {
//                     role: 'user',
//                     content: prompt
//                 }
//             ],
//             modalities: ['image', 'text']
//         };

//         // Add image_config with aspect ratio if a ratio is selected
//         if (selectedRatioName) {
//             requestBody.image_config = {
//                 aspect_ratio: selectedRatioName
//             };
//         }
        
//         // Get the image model from settings
//         const imageModel = document.getElementById('setting-image-model')?.value || 'google/gemini-2.5-flash-image';
//         requestBody.model = imageModel;
        
//         const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
//             method: 'POST',
//             headers: {
//                 'Authorization': `Bearer ${apiKey}`,
//                 'Content-Type': 'application/json'
//             },
//             body: JSON.stringify(requestBody)
//         });

//         // Check response status
//         if (!response.ok) {
//             const errorData = await response.json().catch(() => ({}));
//             const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
//             throw new Error(`API Error: ${errorMessage}`);
//         }

//         statusDiv.textContent = 'Processing API response...';
//         const data = await response.json();
        
//         let imageUrl = null;

//         // Extract image from response
//         if (data.choices && data.choices[0] && data.choices[0].message) {
//             const message = data.choices[0].message;
            
//             // Various methods to extract image
//             if (message.images && Array.isArray(message.images) && message.images.length > 0) {
//                 if (message.images[0].image_url && message.images[0].image_url.url) {
//                     imageUrl = message.images[0].image_url.url;
//                 }
//             } else if (Array.isArray(message.content)) {
//                 for (const item of message.content) {
//                     if (item.type === 'image_url' && item.image_url && item.image_url.url) {
//                         imageUrl = item.image_url.url;
//                         break;
//                     }
//                 }
//             } else if (typeof message.content === 'string' && message.content.startsWith('data:image')) {
//                 imageUrl = message.content;
//             }

//             if (!imageUrl) {
//                 throw new Error('No image data found in API response. Check console for details.');
//             }
            
//             // Display preview
//             previewImg.src = imageUrl;
//             previewImg.style.display = 'block';
//             statusDiv.textContent = 'Image generated! Adding to Photoshop...';

//             // Add to Photoshop
//             await addImageToPhotoshop(imageUrl);

//             statusDiv.textContent = '✅ Success! Image added to Photoshop as new layer';

//         } else {
//             throw new Error('Invalid API response format: missing choices or message');
//         }

//     } catch (error) {
//         console.error('=== Generation error ===');
//         console.error('Error details:', error);
//         statusDiv.textContent = `❌ Error: ${error.message}`;
//         alert(`Error generating image:\n\n${error.message}`);
//     } finally {
//         generateBtn.disabled = false;
//         generateBtn.textContent = 'Generate & Add to Layer';
//     }
// }
async function generateImage() {
    const logPrefix = "[generateImage]";
    console.log(`${logPrefix} 🚀 Function called`);
    
    // CRITICAL: Check ALL elements immediately
    console.log(`${logPrefix} 🔍 Starting DOM element lookup...`);
    
    // FIX: Use the correct ID from Settings tab
    const apiKeyElement = document.getElementById('openrouter-api-key-input');
    console.log(`${logPrefix} openrouter-api-key-input element:`, apiKeyElement);
    console.log(`${logPrefix} openrouter-api-key-input tagName:`, apiKeyElement?.tagName);
    console.log(`${logPrefix} openrouter-api-key-input type:`, apiKeyElement?.type);
    console.log(`${logPrefix} openrouter-api-key-input value (raw):`, apiKeyElement?.value);
    
    const promptElement = document.getElementById('prompt');
    console.log(`${logPrefix} prompt element:`, promptElement);
    
    const generateBtn = document.getElementById('generate-btn');
    console.log(`${logPrefix} generate-btn element:`, generateBtn);
    
    // Optional: Create the preview image element if it doesn't exist, or remove this feature
    let previewImg = document.getElementById('generated-image');
    console.log(`${logPrefix} generated-image element:`, previewImg);
    
    const statusDiv = document.getElementById('status');
    console.log(`${logPrefix} status element:`, statusDiv);
    
    // Now try to get values
    console.log(`${logPrefix} 🔍 Attempting to get values...`);
    
    let apiKey, prompt;
    try {
        // SAFE: Check if value exists before calling trim()
        const rawApiKey = apiKeyElement?.value;
        apiKey = (rawApiKey !== null && rawApiKey !== undefined) ? String(rawApiKey).trim() : '';
        console.log(`${logPrefix} API key retrieved:`, apiKey ? 'YES (length: ' + apiKey.length + ')' : 'NO/EMPTY');
    } catch (e) {
        console.error(`${logPrefix} ❌ Error getting API key:`, e);
        apiKey = '';
    }
    
    try {
        const rawPrompt = promptElement?.value;
        prompt = (rawPrompt !== null && rawPrompt !== undefined) ? String(rawPrompt).trim() : '';
        console.log(`${logPrefix} Prompt retrieved:`, prompt ? 'YES (length: ' + prompt.length + ')' : 'NO/EMPTY');
    } catch (e) {
        console.error(`${logPrefix} ❌ Error getting prompt:`, e);
        prompt = '';
    }
    
    console.log(`${logPrefix} 📍 DOM Elements Summary:`, {
        apiKeyElement: apiKeyElement ? '✅ Found' : '❌ NULL',
        apiKey: apiKey ? '✅ Found (length: ' + apiKey.length + ')' : '❌ Empty',
        promptElement: promptElement ? '✅ Found' : '❌ NULL',
        prompt: prompt ? '✅ Found (length: ' + prompt.length + ')' : '❌ Empty',
        generateBtn: generateBtn ? '✅ Found' : '❌ NULL',
        previewImg: previewImg ? '✅ Found' : '❌ NULL (optional)',
        statusDiv: statusDiv ? '✅ Found' : '❌ NULL'
    });

    // Check for critical null elements
    if (!statusDiv) {
        console.error(`${logPrefix} ❌ CRITICAL: status element not found in DOM`);
        alert('UI Error: Status display element not found. Please check the HTML.');
        return;
    }
    
    if (!generateBtn) {
        console.error(`${logPrefix} ❌ CRITICAL: generate-btn element not found in DOM`);
        statusDiv.textContent = '❌ Generate button not found.';
        return;
    }
    
    if (!previewImg) {
        console.warn(`${logPrefix} ⚠️ WARNING: generated-image element not found in DOM - preview will be skipped`);
    }
    
    if (!apiKeyElement) {
        console.error(`${logPrefix} ❌ CRITICAL: openrouter-api-key-input element not found in DOM`);
        statusDiv.textContent = '❌ API key input not found.';
        alert('UI Error: API key input element not found. Please check the HTML.');
        return;
    }

    // Validation
    if (!apiKey) {
        console.log(`${logPrefix} ⚠️ No API key provided`);
        statusDiv.textContent = '❌ Please enter your OpenRouter API key in the Settings tab';
        alert('Please enter your OpenRouter API key in the Settings tab');
        return;
    }

    if (!prompt) {
        console.log(`${logPrefix} ⚠️ No prompt provided`);
        alert('Please enter an image prompt');
        return;
    }

    console.log(`${logPrefix} ✅ All validations passed, proceeding with generation...`);

    try {
        // Update UI
        console.log(`${logPrefix} 🔄 Updating UI state to generating...`);
        generateBtn.disabled = true;
        generateBtn.textContent = 'Generating...';
        statusDiv.textContent = 'Sending request to OpenRouter API...';
        
        // Get selected aspect ratio from dropdown
        const imageSizeSelect = document.getElementById('image-size-select');
        const selectedRatioName = imageSizeSelect?.value || '';
        console.log(`${logPrefix} 📐 Image size select:`, {
            element: imageSizeSelect ? '✅ Found' : '❌ NULL',
            selectedRatio: selectedRatioName || 'None selected'
        });
        
        const requestBody = {
            model: 'google/gemini-2.5-flash-image-preview',
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ],
            modalities: ['image', 'text']
        };

        // Add image_config with aspect ratio if a ratio is selected
        if (selectedRatioName) {
            requestBody.image_config = {
                aspect_ratio: selectedRatioName
            };
            console.log(`${logPrefix} 📐 Added aspect_ratio to request:`, selectedRatioName);
        }
        
        // Get the image model from settings
        const imageModelInput = document.getElementById('setting-image-model');
        const imageModel = imageModelInput?.value || 'google/gemini-2.5-flash-image';
        requestBody.model = imageModel;
        console.log(`${logPrefix} 🤖 Using model:`, imageModel);
        console.log(`${logPrefix} 📤 Request body:`, JSON.stringify(requestBody, null, 2));
        
        console.log(`${logPrefix} 🌐 Sending API request...`);
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        console.log(`${logPrefix} 📥 Response received:`, {
            status: response.status,
            statusText: response.statusText,
            ok: response.ok
        });

        // Check response status
        if (!response.ok) {
            console.error(`${logPrefix} ❌ API request failed with status:`, response.status);
            const errorData = await response.json().catch(() => ({}));
            console.error(`${logPrefix} ❌ Error data:`, errorData);
            const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
            throw new Error(`API Error: ${errorMessage}`);
        }

        console.log(`${logPrefix} 🔄 Processing API response...`);
        statusDiv.textContent = 'Processing API response...';
        const data = await response.json();
        console.log(`${logPrefix} 📦 Parsed response data:`, data);
        
        let imageUrl = null;

        // Extract image from response
        if (data.choices && data.choices[0] && data.choices[0].message) {
            const message = data.choices[0].message;
            console.log(`${logPrefix} 📨 Message object:`, message);
            
            // Various methods to extract image
            if (message.images && Array.isArray(message.images) && message.images.length > 0) {
                console.log(`${logPrefix} 🔍 Found images array with ${message.images.length} items`);
                if (message.images[0].image_url && message.images[0].image_url.url) {
                    imageUrl = message.images[0].image_url.url;
                    console.log(`${logPrefix} ✅ Extracted imageUrl from message.images[0].image_url.url`);
                }
            } else if (Array.isArray(message.content)) {
                console.log(`${logPrefix} 🔍 Message content is array with ${message.content.length} items`);
                for (const item of message.content) {
                    console.log(`${logPrefix} 🔍 Checking content item:`, item);
                    if (item.type === 'image_url' && item.image_url && item.image_url.url) {
                        imageUrl = item.image_url.url;
                        console.log(`${logPrefix} ✅ Extracted imageUrl from content array`);
                        break;
                    }
                }
            } else if (typeof message.content === 'string' && message.content.startsWith('data:image')) {
                console.log(`${logPrefix} 🔍 Message content is base64 string`);
                imageUrl = message.content;
                console.log(`${logPrefix} ✅ Extracted imageUrl from string content`);
            } else {
                console.warn(`${logPrefix} ⚠️ Message content type:`, typeof message.content);
            }

            if (!imageUrl) {
                console.error(`${logPrefix} ❌ No image URL extracted from response`);
                console.error(`${logPrefix} ❌ Full response for debugging:`, JSON.stringify(data, null, 2));
                throw new Error('No image data found in API response. Check console for details.');
            }
            
            console.log(`${logPrefix} 🖼️ Image URL extracted (length: ${imageUrl.length})`);
            console.log(`${logPrefix} 🖼️ Image URL preview:`, imageUrl.substring(0, 100) + '...');
            
            // Display preview (only if element exists)
            if (previewImg) {
                console.log(`${logPrefix} 🔄 Setting preview image...`);
                previewImg.src = imageUrl;
                previewImg.style.display = 'block';
                console.log(`${logPrefix} ✅ Preview image set`);
            }
            
            statusDiv.textContent = 'Image generated! Adding to Photoshop...';

            // Add to Photoshop
            console.log(`${logPrefix} 🔄 Adding image to Photoshop...`);
            await addImageToPhotoshop(imageUrl);
            console.log(`${logPrefix} ✅ Image added to Photoshop successfully`);

            statusDiv.textContent = '✅ Success! Image added to Photoshop as new layer';
            console.log(`${logPrefix} ✅ Process completed successfully`);

        } else {
            console.error(`${logPrefix} ❌ Invalid response structure`);
            console.error(`${logPrefix} ❌ Missing choices or message in response`);
            console.error(`${logPrefix} ❌ Full response:`, JSON.stringify(data, null, 2));
            throw new Error('Invalid API response format: missing choices or message');
        }

    } catch (error) {
        console.error(`${logPrefix} ❌ Error caught:`, error);
        console.error(`${logPrefix} ❌ Error type:`, error.constructor.name);
        console.error(`${logPrefix} ❌ Error message:`, error.message);
        console.error(`${logPrefix} ❌ Error stack:`, error.stack);
        
        statusDiv.textContent = `❌ Error: ${error.message}`;
        console.log(`${logPrefix} 📝 Status message set to:`, statusDiv.textContent);
        
        alert(`Error generating image:\n\n${error.message}`);
    } finally {
        console.log(`${logPrefix} 🔄 Restoring UI state...`);
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate & Add to Layer';
        console.log(`${logPrefix} ✅ UI state restored`);
    }
    
    console.log(`${logPrefix} 🏁 Function complete`);
}
function initializeEventListeners() {
    setTimeout(() => {
        // Load settings from localStorage on initialization
        loadSettings();
        
        // ... (Existing T2I, Img2Img, Add Selection element variables) ...
        const generateBtn = document.getElementById('generate-btn');
        const img2imgBtn = document.getElementById('img2img-btn'); 
        const addSelectionBtn = document.getElementById('add-selection-btn');
        console.log('addSelectionBtn found:', !!addSelectionBtn);
        const selectElement = document.getElementById('aspect-ratio-select');
        const imageSizeSelect = document.getElementById('image-size-select');
        const promptInput = document.getElementById('prompt');
        const img2imgPromptInput = document.getElementById('prompt-img2img');
        const apiKeyInput = document.getElementById('api-key');



        // NEW SCALER ELEMENTS
        const scaleSlider = document.getElementById('scale-slider');
        const scaleValueSpan = document.getElementById('scale-value');


        // --- NEW Scale Event Listeners ---
        if (scaleSlider) {
            
            // SLIDER INPUT: Update the percentage text dynamically (always happens)
            scaleSlider.addEventListener('input', () => {
                scaleValueSpan.textContent = `${scaleSlider.value}%`;
            });
            
            // SLIDER CHANGE: Trigger the expensive Photoshop update when the user stops dragging
            // This is the new primary action trigger, replacing the button click.
            scaleSlider.addEventListener('change', scaleSelectionByPercent);

            console.log('✓ Selection scaler controls initialized for dynamic scaling.');
        }

        // Populate Aspect Ratio Dropdown
        if (selectElement) {
            SUPPORTED_ASPECT_RATIOS.forEach((item, index) => {
                const option = document.createElement('option');
                option.value = index;
                option.textContent = `${item.name} (${item.width}x${item.height} px)`;
                selectElement.appendChild(option);
            });
            selectElement.selectedIndex = 0;
        }

        // Populate Image Size Dropdown for Text-to-Image
        if (imageSizeSelect) {
            SUPPORTED_ASPECT_RATIOS.forEach((item, index) => {
                const option = document.createElement('option');
                option.value = item.name; // Use the name (e.g., "1:1", "2:3") as the value
                option.textContent = `${item.name} (${item.width}x${item.height} px)`;
                imageSizeSelect.appendChild(option);
            });
            // Set default to first option (1:1)
            imageSizeSelect.selectedIndex = 0;
        }

        // Add Selection Event Listener
        console.log('Attempting to attach event listener to addSelectionBtn:', addSelectionBtn);
        if (addSelectionBtn) {
            addSelectionBtn.addEventListener('click', addSelectionToDocument);
            console.log('Successfully attached event listener to addSelectionBtn');
        } else {
            console.log('addSelectionBtn not found, skipping event listener attachment');
        }
        
        // API Key visibility toggle
        const toggleApiKeyVisibilityBtn = document.getElementById('toggle-api-key-visibility');
        if (toggleApiKeyVisibilityBtn) {
            toggleApiKeyVisibilityBtn.addEventListener('click', () => {
                const apiKeyInput = document.getElementById('openrouter-api-key-input');
                if (apiKeyInput.type === 'password') {
                    apiKeyInput.type = 'text';
                    toggleApiKeyVisibilityBtn.textContent = 'Hide';
                } else {
                    apiKeyInput.type = 'password';
                    toggleApiKeyVisibilityBtn.textContent = 'Show';
                }
            });
        }
        
        // API Status Check Button
        const checkApiStatusBtn = document.getElementById('check-api-status-btn');
        if (checkApiStatusBtn) {
            checkApiStatusBtn.addEventListener('click', checkOpenRouterStatus);
        }
        
        // Export Settings Button
        const exportSettingsBtn = document.getElementById('export-settings-btn');
        console.log('Export settings button found:', !!exportSettingsBtn);
        if (exportSettingsBtn) {
            exportSettingsBtn.addEventListener('click', () => {
                exportSettings();
            });
            console.log('Export settings event listener attached');
        }
        
        // Import Settings Button
        const importSettingsBtn = document.getElementById('import-settings-btn');
        const importSettingsFileInput = document.getElementById('import-settings-file');
        console.log('Import settings button found:', !!importSettingsBtn);
        console.log('Import settings file input found:', !!importSettingsFileInput);
        if (importSettingsBtn) {
            importSettingsBtn.addEventListener('click', async () => {
                console.log('Import settings button clicked');
                // Load settings directly from plugin data folder
                await importSettingsFromDataFolder();
            });
        }
        // Keep file input listener for backward compatibility (but won't be used)
        if (importSettingsFileInput) {
            importSettingsFileInput.addEventListener('change', (event) => {
                console.log('Import settings file selected:', event.target.files.length);
                if (event.target.files.length > 0) {
                    importSettings(event);
                }
            });
        }
        
        // Add event listeners for image context checkboxes to handle visual state
        const imageContextCheckbox = document.getElementById('image-context-checkbox');
        if (imageContextCheckbox) {
            imageContextCheckbox.addEventListener('change', function() {
                const svg = this.nextElementSibling;
                if (svg && svg.tagName.toLowerCase() === 'svg') {
                    if (this.checked) {
                        svg.style.color = '#4a90e2'; // --c-primary
                        svg.style.borderColor = '#4a90e2'; // Keep border when checked
                        svg.style.borderWidth = '1px';
                        svg.style.borderStyle = 'solid';
                    } else {
                        svg.style.color = ''; // Reset to default color
                        svg.style.borderColor = ''; // Reset border
                        svg.style.borderWidth = '';
                        svg.style.borderStyle = '';
                    }
                }
            });
        }
        
        const imageContextImg2ImgCheckbox = document.getElementById('image-context-img2img-checkbox');
        if (imageContextImg2ImgCheckbox) {
            imageContextImg2ImgCheckbox.addEventListener('change', function() {
                const svg = this.nextElementSibling;
                if (svg && svg.tagName.toLowerCase() === 'svg') {
                    if (this.checked) {
                        svg.style.color = '#4a90e2'; // --c-primary
                        svg.style.borderColor = '#4a90e2'; // Keep border when checked
                        svg.style.borderWidth = '1px';
                        svg.style.borderStyle = 'solid';
                    } else {
                        svg.style.color = ''; // Reset to default color
                        svg.style.borderColor = ''; // Reset border
                        svg.style.borderWidth = '';
                        svg.style.borderStyle = '';
                    }
                }
            });
        }
        
        console.log('Import settings event listeners attached');
        
        // Add event listeners to save settings when they change
        const openrouterApiKeyInput = document.getElementById('openrouter-api-key-input');
        if (openrouterApiKeyInput) {
            openrouterApiKeyInput.addEventListener('change', saveSettings);
        }
        
        const textModelInput = document.getElementById('setting-text-model');
        if (textModelInput) {
            textModelInput.addEventListener('change', saveSettings);
        }
        
        const visionModelInput = document.getElementById('setting-vision-model');
        if (visionModelInput) {
            visionModelInput.addEventListener('change', saveSettings);
        }
        
        const imageModelInput = document.getElementById('setting-image-model');
        if (imageModelInput) {
            imageModelInput.addEventListener('change', saveSettings);
        }
        
        const optimizerPromptInput = document.getElementById('setting-optimizer-prompt');
        if (optimizerPromptInput) {
            optimizerPromptInput.addEventListener('change', saveSettings);
        }
        
        // Add event listeners for prompt optimization
        const optimizePromptBtn = document.getElementById('optimize-prompt-btn');
        if (optimizePromptBtn) {
            optimizePromptBtn.addEventListener('click', () => optimizePrompt('prompt', 'image-context-checkbox'));
        }
        
        const optimizePromptImg2ImgBtn = document.getElementById('optimize-prompt-img2img-btn');
        if (optimizePromptImg2ImgBtn) {
            optimizePromptImg2ImgBtn.addEventListener('click', () => optimizePrompt('prompt-img2img', 'image-context-img2img-checkbox'));
        }
        


        // ... (Existing T2I and Img2Img event listeners remain the same) ...
        if (generateBtn) {
            generateBtn.addEventListener('click', generateImage);
        }
        
        if (img2imgBtn) {
            img2imgBtn.addEventListener('click', imageToImageGenerate); 
        }

        if (promptInput) {
            promptInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    generateImage();
                }
            });
            promptInput.disabled = false;
        }
        
        if (img2imgPromptInput) {
             img2imgPromptInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    imageToImageGenerate();
                }
            });
        }

        if (apiKeyInput) {
            // Log for initialization
        }

        // Tab switching functionality
        const tabBtns = document.querySelectorAll('.tab-btn');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                // Remove active class from all buttons and hide all tab contents
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(content => {
                    content.style.display = 'none';
                });
                
                // Add active class to clicked button
                btn.classList.add('active');
                
                // Show corresponding tab content
                const tabId = btn.getAttribute('data-tab');
                document.getElementById(tabId).style.display = 'block';
            });
        });

        console.log('Plugin ready!');
    }, 100);
}

// Initialize plugin
initializeEventListeners();
console.log('Photoshop AI Image Generator Plugin Loaded');
console.log('Version: 2.2.0 (Selection Modifiers Added)');

// Function to create a smart object from the current active layer
function createSmartObject() {
    var idnewPlacedLayer = stringIDToTypeID( 'newPlacedLayer' );
    executeAction(idnewPlacedLayer, undefined, DialogModes.NO);
}

// API Status Check Function
async function checkOpenRouterStatus() {
    console.log('[checkOpenRouterStatus] Starting API status check...');

    const apiKeyInput = document.getElementById('openrouter-api-key-input');
    const statusLabel = document.getElementById('api-status');
    const statusLimit = document.getElementById('api-limit');
    const statusUsage = document.getElementById('api-usage');
    const statusRemaining = document.getElementById('api-remaining');

    console.log('[checkOpenRouterStatus] DOM elements found:', {
        apiKeyInput: !!apiKeyInput,
        statusLabel: !!statusLabel,
        statusLimit: !!statusLimit,
        statusUsage: !!statusUsage,
        statusRemaining: !!statusRemaining
    });

    if (!apiKeyInput || !statusLabel || !statusLimit || !statusUsage || !statusRemaining) {
        console.error('[checkOpenRouterStatus] Some DOM elements not found!');
        return;
    }

    const apiKey = apiKeyInput.value?.trim();
    console.log('[checkOpenRouterStatus] API key present:', !!apiKey, 'length:', apiKey?.length || 0);

    if (!apiKey) {
        console.log('[checkOpenRouterStatus] No API key provided, setting N/A');
        statusLabel.textContent = 'N/A';
        statusLimit.textContent = 'N/A';
        statusUsage.textContent = 'N/A';
        statusRemaining.textContent = 'N/A';
        return;
    }

    try {
        // Show loading state
        console.log('[checkOpenRouterStatus] Setting loading state...');
        statusLabel.textContent = 'Checking...';
        statusLimit.textContent = '...';
        statusUsage.textContent = '...';
        statusRemaining.textContent = '...';

        console.log('[checkOpenRouterStatus] Making API request...');
        const response = await fetch('https://openrouter.ai/api/v1/key', {
            headers: {
                'Authorization': `Bearer ${apiKey}`
            }
        });

        console.log('[checkOpenRouterStatus] Response status:', response.status);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        console.log('[checkOpenRouterStatus] API response data:', data);

        // Update the individual status elements based on the new response format
        const label = data.data?.label || 'N/A';
        const limit = data.data?.limit ? formatBytes(data.data.limit) : 'N/A';
        const usage = data.data?.usage ? formatBytes(data.data.usage) : 'N/A';
        const remaining = data.data?.limit_remaining ? formatBytes(data.data.limit_remaining) : 'N/A';

        console.log('[checkOpenRouterStatus] Setting values:', { label, limit, usage, remaining });

        statusLabel.textContent = label;
        statusLimit.textContent = limit;
        statusUsage.textContent = usage;
        statusRemaining.textContent = remaining;

        console.log('[checkOpenRouterStatus] Status update complete');

    } catch (error) {
        console.error('[checkOpenRouterStatus] Error:', error);
        statusLabel.textContent = 'Error';
        statusLimit.textContent = 'Error';
        statusUsage.textContent = 'Error';
        statusRemaining.textContent = error.message || 'Invalid API key or network error';
    }
}

// Helper function to format currency values
function formatBytes(bytes) {
    // Format as USD with 2 decimal places
    return '$' + parseFloat(bytes).toFixed(2);
}

// Export Settings Function
async function exportSettings() {
    try {
        const settings = {
            apiKey: document.getElementById('openrouter-api-key-input')?.value || '',
            textModel: document.getElementById('setting-text-model')?.value || 'google/gemini-2.0-flash-001',
            visionModel: document.getElementById('setting-vision-model')?.value || 'google/gemini-2.0-flash-001',
            imageModel: document.getElementById('setting-image-model')?.value || 'google/gemini-2.5-flash-image',
            optimizerPrompt: document.getElementById('setting-optimizer-prompt')?.value || 'act as image generation prompt engineer and optimize user prompt'
        };
        
        const dataStr = JSON.stringify(settings, null, 2);
        const exportFileDefaultName = 'settings.json';
        
        // Use the data folder which doesn't require special permissions
        const fs = require('uxp').storage.localFileSystem;
        const dataFolder = await fs.getDataFolder();
        const file = await dataFolder.createFile(exportFileDefaultName, { overwrite: true });
        
        // Write the settings to the file
        await file.write(dataStr, { 
            format: require('uxp').storage.formats.utf8
        });
        
        console.log('Settings exported successfully to data folder');
        console.log('File saved at:', file.nativePath);
        
        // Show success message in UI below Settings Data section
        const statusDiv = document.getElementById('settings-status-message');
        if (statusDiv) {
            statusDiv.innerHTML = `<div style="margin: 10px 0; padding: 8px; background-color: #d4edda; border: 1px solid #c3e6cb; border-radius: 4px; color: #155724;">Settings exported successfully! File saved at: ${file.nativePath}</div>`;
        }
    } catch (error) {
        console.error('Export Settings Error:', error);
        // Show error message in UI below Settings Data section
        const statusDiv = document.getElementById('settings-status-message');
        if (statusDiv) {
            statusDiv.innerHTML = `<div style="margin: 10px 0; padding: 8px; background-color: #f8d7da; border: 1px solid #f5c6cb; border-radius: 4px; color: #721c24;">Error exporting settings: ${error.message}</div>`;
        }
    }
}

// Import Settings Function (from file input - for backward compatibility)
async function importSettings(event) {
    try {
        // For the file input approach (when called from file input change event)
        if (event && event.target && event.target.files && event.target.files[0]) {
            const file = event.target.files[0];
            const fileContent = await file.read({format: require('uxp').storage.formats.utf8});
            const settings = JSON.parse(fileContent);
            
            // Update the input fields with imported settings
            const apiKeyInput = document.getElementById('openrouter-api-key-input');
            if (apiKeyInput) apiKeyInput.value = settings.apiKey || '';
            
            const textModelInput = document.getElementById('setting-text-model');
            if (textModelInput) textModelInput.value = settings.textModel || 'google/gemini-2.0-flash-001';
            
            const visionModelInput = document.getElementById('setting-vision-model');
            if (visionModelInput) visionModelInput.value = settings.visionModel || 'google/gemini-2.0-flash-001';
            
            const imageModelInput = document.getElementById('setting-image-model');
            if (imageModelInput) imageModelInput.value = settings.imageModel || 'google/gemini-2.5-flash-image';
            
            const optimizerPromptInput = document.getElementById('setting-optimizer-prompt');
            if (optimizerPromptInput) optimizerPromptInput.value = settings.optimizerPrompt || 'act as image generation prompt engineer and optimize user prompt';
            
            // Save the imported settings to localStorage
            saveSettings();
            
            // Reset the file input
            if (event.target) event.target.value = '';
            
            console.log('Settings imported successfully');
            
            // Show success message in UI below Settings Data section
            const statusDiv = document.getElementById('settings-status-message');
            if (statusDiv) {
                statusDiv.innerHTML = `<div style="margin: 10px 0; padding: 8px; background-color: #d4edda; border: 1px solid #c3e6cb; border-radius: 4px; color: #155724;">Settings imported successfully!</div>`;
            }
        }
    } catch (error) {
        console.error('Import Settings Error:', error);
        // Show error message in UI below Settings Data section
        const statusDiv = document.querySelector('.section-divider:last-child .setting-row') || document.getElementById('status');
        if (statusDiv) {
            statusDiv.innerHTML = `<div style="margin-top: 10px; padding: 8px; background-color: #f8d7da; border: 1px solid #f5c6cb; border-radius: 4px; color: #721c24;">Error importing settings: ${error.message}</div>`;
        }
    }
}

// New function to import settings directly from plugin data folder
async function importSettingsFromDataFolder() {
    try {
        // Use the data folder to read the settings file directly
        const fs = require('uxp').storage.localFileSystem;
        const dataFolder = await fs.getDataFolder();
        
        // Try to get the settings file
        let file;
        try {
            file = await dataFolder.getEntry('settings.json');
        } catch (e) {
            // File doesn't exist
            file = null;
        }
        
        if (file) {
            const fileContent = await file.read({format: require('uxp').storage.formats.utf8});
            const settings = JSON.parse(fileContent);
            
            // Update the input fields with imported settings
            const apiKeyInput = document.getElementById('openrouter-api-key-input');
            if (apiKeyInput) apiKeyInput.value = settings.apiKey || '';
            
            const textModelInput = document.getElementById('setting-text-model');
            if (textModelInput) textModelInput.value = settings.textModel || 'google/gemini-2.0-flash-001';
            
            const visionModelInput = document.getElementById('setting-vision-model');
            if (visionModelInput) visionModelInput.value = settings.visionModel || 'google/gemini-2.0-flash-001';
            
            const imageModelInput = document.getElementById('setting-image-model');
            if (imageModelInput) imageModelInput.value = settings.imageModel || 'google/gemini-2.5-flash-image';
            
            const optimizerPromptInput = document.getElementById('setting-optimizer-prompt');
            if (optimizerPromptInput) optimizerPromptInput.value = settings.optimizerPrompt || 'act as image generation prompt engineer and optimize user prompt';
            
            // Save the imported settings to localStorage
            saveSettings();
            
            console.log('Settings imported successfully from data folder');
            
            // Show success message in UI below Settings Data section
            const statusDiv = document.getElementById('settings-status-message');
            if (statusDiv) {
                statusDiv.innerHTML = `<div style="margin: 10px 0; padding: 8px; background-color: #d4edda; border: 1px solid #c3e6cb; border-radius: 4px; color: #155724;">Settings imported successfully from data folder!</div>`;
            }
        } else {
            // Show error message in UI below Settings Data section
            const statusDiv = document.getElementById('settings-status-message');
            if (statusDiv) {
                statusDiv.innerHTML = `<div style="margin: 10px 0; padding: 8px; background-color: #f8d7da; border: 1px solid #f5c6cb; border-radius: 4px; color: #721c24;">No settings file found in data folder. Please export settings first.</div>`;
            }
        }
    } catch (error) {
        console.error('Import Settings Error:', error);
        // Show error message in UI below Settings Data section
        const statusDiv = document.querySelector('.section-divider:last-child .setting-row') || document.getElementById('status');
        if (statusDiv) {
            statusDiv.innerHTML = `<div style="margin-top: 10px; padding: 8px; background-color: #f8d7da; border: 1px solid #f5c6cb; border-radius: 4px; color: #721c24;">Error importing settings: ${error.message}</div>`;
        }
    }
}

// Optimize Prompt Function
async function optimizePrompt(promptInputId, imageCheckboxId) {
    const promptInput = document.getElementById(promptInputId);
    const imageCheckbox = document.getElementById(imageCheckboxId);
    const currentPrompt = promptInput.value;
    
    if (!currentPrompt.trim()) {
        alert('Please enter a prompt to optimize.');
        return;
    }
    
    // Show a temporary message while optimizing
    const originalValue = promptInput.value;
    promptInput.value = 'Optimizing prompt...';
    promptInput.disabled = true;
    
    try {
        // Determine which model and system prompt to use based on the checkbox
        let model, systemPrompt;
        if (imageCheckbox && imageCheckbox.checked) {
            // Use Vision Model with image context
            model = document.getElementById('setting-vision-model').value;
            systemPrompt = document.getElementById('setting-optimizer-prompt').value;
            
            // Extract the current selection image
            const imageResult = await extractSelectionImage();
            const base64Image = `data:image/png;base64,${imageResult.base64Image}`;
            
            // Call the OpenRouter API with image context
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${API_KEY_REF}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: currentPrompt },
                                { type: 'image_url', image_url: { url: base64Image } }
                            ],
                        },
                    ],
                }),
            });
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            if (data.choices && data.choices[0] && data.choices[0].message) {
                const optimizedPrompt = data.choices[0].message.content;
                promptInput.value = optimizedPrompt;
            } else {
                throw new Error('Invalid response format from API');
            }
        } else {
            // Use Text Model without image context
            model = document.getElementById('setting-text-model').value;
            systemPrompt = document.getElementById('setting-optimizer-prompt').value;
            
            // Call the OpenRouter API with text-only
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${API_KEY_REF}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: currentPrompt }
                    ],
                }),
            });
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            if (data.choices && data.choices[0] && data.choices[0].message) {
                const optimizedPrompt = data.choices[0].message.content;
                promptInput.value = optimizedPrompt;
            } else {
                throw new Error('Invalid response format from API');
            }
        }
    } catch (error) {
        console.error('Prompt Optimization Error:', error);
        promptInput.value = originalValue; // Restore original value if error occurs
        alert(`Error optimizing prompt: ${error.message}`);
    } finally {
        promptInput.disabled = false; // Re-enable the input field
    }
}