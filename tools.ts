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