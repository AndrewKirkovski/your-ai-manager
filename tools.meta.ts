// Define the get_current_time tool
import {Tool} from "./tool.types";
import {getCurrentTime} from "./dateUtils";

export const get_current_time: Tool = {
    name: 'get_current_time',
    description: 'Get the current time in ISO format',
    parameters: {
        type: 'object',
        properties: {}
    },
    execute: async (args: { userId: string }) => {
        const timezone = 'Europe/Warsaw';
        const currentTime = getCurrentTime(timezone);
        return {currentTime: currentTime.toISO()}
    }
};