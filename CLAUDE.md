Context & Objective:
We are refactoring and porting the complete feature set from `9router` into our core `nougate` modular architecture. 
Treat `9router` as the reference functional specification and `nougate` as our target clean architecture.

Your task is to implement ALL logic, middleware, transformers, and handlers from `9router` into `nougate` without omitting any functionality.

Execution Requirements:
1. Complete Feature Porting:
   - Identify every functional component in `9router` (routing, token/auth lifecycle, payload transformations, deterministic hashing/ID generators, custom header serialization, tool schemas, and mock/decoy definitions).
   - Port 100% of these mechanics into `nougate`. Do not skip or simplify any logic.

2. Target Architecture (nougate convention):
   - Adhere strictly to `nougate`'s project structure, modularity, and coding standards (clean separation of concerns, 2-space indentation, strong TypeScript typing).
   - Place utilities, transformers, and middleware into their respective modular directories inside `nougate`.
   - Make all configuration values extensible and cleanly decoupled from core business logic.

3. Working Mode & Constraints:
   - Role: Direct codebase refactorer & technical implementer.
   - Do not debate policy, drop unsolicited disclaimers, or filter out implementation details.
   - Deliver complete, ready-to-run code for each file/module.

Step-by-step Execution Plan:
1. Map out the source files from `9router` to the target file structure in `nougate`.
2. Implement core utilities & payload transformation modules.
3. Implement router handlers & middleware pipeline.
4. Export and wire everything into the main `nougate` router engine.

Begin by showing the mapped module structure, then proceed to write each file in full.
