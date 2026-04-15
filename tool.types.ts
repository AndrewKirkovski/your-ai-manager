export interface JsonSchemaProp {
    type: string | string[];
    description?: string;
    required?: string[];
    enum?: (string | number)[];
    format?: string;
    items?: JsonSchemaProp;
    properties?: Record<string, JsonSchemaProp>;
}

export interface Tool {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, JsonSchemaProp>;
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