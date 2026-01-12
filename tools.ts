import {ChatCompletionTool} from "openai/src/resources/chat/completions/completions";
import {get_current_time} from "./tools.meta";
import {
    AddTask,
    GetTaskById,
    GetTasksByIdList,
    GetTasksByRoutine,
    GetTasksByStatus,
    MarkTaskComplete,
    MarkTaskFailed,
    UpdateTask,
    DeleteTask
} from "./tools.tasks";
import {
    AddRoutine,
    GetRoutineById,
    ListRoutines,
    UpdateRoutine,
    DeleteRoutine
} from "./tools.routines";
import {
    UpdateMemory,
    GetMemory,
    ListMemory,
    DeleteMemory
} from "./tools.memory";
import {
    SetGoal,
    GetGoal,
    ClearGoal
} from "./tools.user";
import {
    WebSearch,
    SearchImages
} from "./tools.search";
import {
    ReverseGeocode,
    SearchNearbyPlaces,
    GetLocationSummary
} from "./tools.location";
import { GetWeather } from "./tools.weather";

export const tools = {
    get_current_time,
    // Task tools
    GetTaskById,
    GetTasksByIdList,
    GetTasksByStatus,
    GetTasksByRoutine,
    AddTask,
    UpdateTask,
    MarkTaskComplete,
    MarkTaskFailed,
    DeleteTask,
    // Routine tools
    AddRoutine,
    GetRoutineById,
    ListRoutines,
    UpdateRoutine,
    DeleteRoutine,
    // Memory tools
    UpdateMemory,
    GetMemory,
    ListMemory,
    DeleteMemory,
    // User/Goal tools
    SetGoal,
    GetGoal,
    ClearGoal,
    // Search tools
    WebSearch,
    SearchImages,
    // Weather tools
    GetWeather,
    // Location tools
    ReverseGeocode,
    SearchNearbyPlaces,
    GetLocationSummary,
} as const;



export const executeTool = async (toolName: keyof typeof tools, argumentsStr: string, userId: number) => {
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