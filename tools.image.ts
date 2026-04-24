import {Tool} from "./tool.types";
import {getRecentImages} from "./userStore";
import {getMediaParser} from "./mediaParser";

export const AnalyzeImage: Tool = {
    name: 'AnalyzeImage',
    description: 'Re-analyze a recently sent photo with a specific focus/prompt. Use when the user asks to look at a previous photo differently (e.g., count calories, read text, identify objects, evaluate mood of people in the photo).',
    parameters: {
        type: 'object',
        properties: {
            prompt: {
                type: 'string',
                description: 'What to focus on when analyzing the image (e.g., "Count calories in this meal", "Read the text in this screenshot", "What brand is this product?")'
            },
            image_index: {
                type: 'number',
                description: 'Which recent image to analyze (0 = most recent, 1 = second most recent, etc.). Defaults to 0.'
            }
        },
        required: ['prompt']
    },
    execute: async (args: { userId: number; prompt: string; image_index?: number }) => {
        const index = args.image_index ?? 0;
        const images = await getRecentImages(args.userId, index + 1);

        if (images.length === 0) {
            return { success: false, message: 'No recent images found. Ask the user to send a photo first.' };
        }

        if (index >= images.length) {
            return { success: false, message: `Only ${images.length} recent image(s) available. Use image_index 0-${images.length - 1}.` };
        }

        const image = images[index];
        const mediaParser = getMediaParser();

        try {
            const analysis = await mediaParser.analyzeImageByFileId(image.fileId, args.prompt, args.userId);
            return {
                success: true,
                analysis,
                image_info: {
                    original_caption: image.caption,
                    original_description: image.description,
                    sent_at: image.timestamp.toISOString(),
                }
            };
        } catch (error) {
            return {
                success: false,
                message: `Failed to analyze image: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
};
