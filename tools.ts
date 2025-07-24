import { getCurrentTime } from './dateUtils';
import {ChatCompletionTool} from "openai/src/resources/chat/completions/completions";
import { getAllTasks, updateUserTask, getTask, Task, TaskStatus } from './userStore';

export interface Tool {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, {
            type: string;
            description: string;
            required?: boolean;
            enum?: string[];
            format?: string;
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

// Define the get_tasks_by_status tool
export const get_tasks_by_status: Tool = {
    name: 'get_tasks_by_status',
    description: 'Fetch all tasks filtered by status',
    parameters: {
        type: 'object',
        properties: {
            status: {
                type: 'string',
                description: 'The status to filter tasks by (e.g., "pending", "completed", "failed")',
                enum: ['pending', 'completed', 'failed']
            }
        },
        required: ['status']
    },
    execute: async (args: { userId: string; status: string }) => {
        const userId = parseInt(args.userId);
        const status = args.status as TaskStatus;
        
        // Validate status
        if (!['pending', 'completed', 'failed'].includes(status)) {
            throw new Error(`Invalid status: ${status}. Must be one of: pending, completed, failed`);
        }
        
        const allTasks = await getAllTasks(userId);
        const filteredTasks = allTasks.filter(task => task.status === status);
        
        return {
            tasks: filteredTasks,
            count: filteredTasks.length,
            status: status
        };
    }
};

// Define the update_task tool
export const update_task: Tool = {
    name: 'update_task',
    description: 'Update a single existing task with new information',
    parameters: {
        type: 'object',
        properties: {
            task_id: {
                type: 'string',
                description: 'The ID of the task to update'
            },
            name: {
                type: 'string',
                description: 'The new name for the task (optional)'
            },
            status: {
                type: 'string',
                description: 'The new status for the task (optional)',
                enum: ['pending', 'completed', 'failed']
            },
            annoyance: {
                type: 'string',
                description: 'The new annoyance level for the task (optional)',
                enum: ['low', 'med', 'high']
            },
            due_at: {
                type: 'string',
                description: 'The new due date for the task in ISO format (optional)',
                format: 'date-time'
            },
            requires_action: {
                type: 'boolean',
                description: 'Whether the task requires action (optional)'
            }
        },
        required: ['task_id']
    },
    execute: async (args: { 
        userId: string; 
        task_id: string; 
        name?: string; 
        status?: string; 
        annoyance?: string; 
        due_at?: string;
        requires_action?: boolean;
    }) => {
        const userId = parseInt(args.userId);
        const taskId = args.task_id;
        
        // Validate status if provided
        if (args.status && !['pending', 'completed', 'failed'].includes(args.status)) {
            throw new Error(`Invalid status: ${args.status}. Must be one of: pending, completed, failed`);
        }
        
        // Validate annoyance level if provided
        if (args.annoyance && !['low', 'med', 'high'].includes(args.annoyance)) {
            throw new Error(`Invalid annoyance level: ${args.annoyance}. Must be one of: low, med, high`);
        }
        
        // Check if task exists
        const existingTask = await getTask(userId, taskId);
        if (!existingTask) {
            throw new Error(`Task with ID ${taskId} not found`);
        }
        
        // Update the task
        await updateUserTask(userId, taskId, (task) => {
            if (args.name !== undefined) task.name = args.name;
            if (args.status !== undefined) task.status = args.status as TaskStatus;
            if (args.annoyance !== undefined) task.annoyance = args.annoyance as 'low' | 'med' | 'high';
            if (args.due_at !== undefined) {
                task.dueAt = args.due_at ? new Date(args.due_at) : undefined;
            }
            if (args.requires_action !== undefined) task.requiresAction = args.requires_action;
            if(args.due_at) {
                task.postponeCount = (task.postponeCount ?? 0) + 1;
            }
        });
        
        // Get the updated task
        const updatedTask = await getTask(userId, taskId);
        
        return {
            success: true,
            task: updatedTask,
            message: `Task "${updatedTask?.name}" updated successfully`
        };
    }
};

export const tools = {
    get_current_time,
    get_tasks_by_status,
    update_task,
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