
import { getModelSpec } from "../providers/antigravity/config/model-specs";
import { mapOpenAIToGoogle } from "../protocols/openai";

/**
 * Read a model spec for the routing test matrix.
 */
function requireModelSpec(modelId: string) {
    const modelSpec = getModelSpec(modelId);
    if (!modelSpec) {
        throw new Error(`Unknown model spec: ${modelId}`);
    }
    return modelSpec;
}

const testCases = [
    {
        name: "Gemini 3 Flash (CLI)",
        input: {
            model: "antigravity:gemini-3-flash",
            messages: [{ role: "user", content: "Hi" }]
        },
        projectId: "test-project",
        modelId: "gemini-3-flash"
    },
    {
        name: "Claude Opus Thinking (CLI)",
        input: {
            model: "antigravity:claude-opus-4-6-thinking",
            messages: [{ role: "user", content: "Hi" }]
        },
        projectId: "test-project",
        modelId: "claude-opus-4-6-thinking"
    }
];

console.log("--- STARTING ROUTING TESTS ---");

for (const test of testCases) {
    console.log(`\nTesting: ${test.name}`);
    const result = mapOpenAIToGoogle(
        test.input,
        requireModelSpec(test.modelId),
        "routing-test-session",
        { projectId: test.projectId },
    );
    console.log(`Final Google Model: ${result.model}`);
    
    // Check for double suffixes or weird transformations
    if (result.model.endsWith("-preview-preview")) {
        console.log("FAIL: Double suffix detected!");
    } else {
        console.log("OK: Model name looks valid for registry-driven routing");
    }
}
