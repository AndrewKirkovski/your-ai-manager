import { getCurrentTime } from './dateUtils';
import {ChatCompletionTool} from "openai/src/resources/chat/completions/completions";

export interface Tool {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, {
            type: string;
            description: string;
            required?: boolean;
        }>;
        required?: string[];
    };
    execute: (args: any) => Promise<any>;
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface ToolResult {
    tool_call_id: string;
    role: 'tool';
    content: string;
}

// Define the get_current_time tool
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
        return { currentTime: currentTime.toISO() }
    }
};

export const tools = {
    get_current_time,
} as const;



export const executeTool = async (toolName: keyof typeof tools, argumentsStr: string, userId: string) => {
    try {
        const tool = tools[toolName];
        const args = JSON.parse(argumentsStr || '{}');
        return await tool.execute({
            ...args,
            userId
        });
    } catch (error) {
        throw new Error(`Failed to execute tool '${toolName}': ${error instanceof Error ? error.message : String(error)}`);
    }
}

export const getAllToolDefinitions = () => {
    return Object.values(tools).map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
        }
    } as ChatCompletionTool));
}