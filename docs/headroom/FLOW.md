# Headroom Integration Flow

## Architecture Diagram

```mermaid
graph TD
    Client[Client: Cursor/Cline/OpenClaw] -->|POST /v1/chat/completions| Gateway[Nougate Gateway]
    
    Gateway -->|1. Parse Request| Handler{Protocol Handler}
    
    Handler -->|OpenAI Protocol| OpenAIHandler[OpenAI Handler]
    Handler -->|Anthropic Protocol| AnthropicHandler[Anthropic Handler]
    
    OpenAIHandler -->|2. Check Config| ConfigCheck{headroom.enabled?}
    AnthropicHandler -->|2. Check Config| ConfigCheck
    
    ConfigCheck -->|false| DirectUpstream[Send Original Payload]
    ConfigCheck -->|true| URLCheck{URL configured?}
    
    URLCheck -->|no URL| Fallback1[⚠️ Warning: No URL<br/>Use Original Payload]
    URLCheck -->|has URL| CompressRequest[3. POST to Headroom<br/>/v1/compress]
    
    CompressRequest -->|Success| CompressedPayload[4. Use Compressed Payload]
    CompressRequest -->|Timeout/Error| Fallback2[⚠️ Warning: Compression Failed<br/>Use Original Payload]
    
    CompressedPayload -->|5. Execute| Upstream[Upstream Provider<br/>Copilot/Antigravity/OpenAI]
    DirectUpstream -->|5. Execute| Upstream
    Fallback1 -->|5. Execute| Upstream
    Fallback2 -->|5. Execute| Upstream
    
    Upstream -->|6. Response| Client
    
    style ConfigCheck fill:#ffd700
    style URLCheck fill:#ffd700
    style CompressedPayload fill:#90ee90
    style Fallback1 fill:#ffcccb
    style Fallback2 fill:#ffcccb
    style DirectUpstream fill:#87ceeb
```

## Configuration Flow

```mermaid
graph LR
    Admin[Admin Dashboard] -->|Toggle Enable| API[PATCH /api/config]
    API -->|Update| ConfigFile[config.json]
    
    ConfigFile -->|Load| Memory[Runtime Config]
    Memory -->|SSE Event| Dashboard[Dashboard UI Update]
    
    Gateway[Request Handler] -->|Read| Memory
    
    style Admin fill:#87ceeb
    style Memory fill:#ffd700
    style Dashboard fill:#90ee90
```

## Decision Tree

```mermaid
flowchart TD
    Start[Request Received] --> CheckEnabled{headroom.enabled<br/>== true?}
    
    CheckEnabled -->|No| UseOriginal[Use Original Payload]
    CheckEnabled -->|Yes| CheckURL{URL available?<br/>config.url || HEADROOM_URL}
    
    CheckURL -->|No| WarnNoURL[Log Warning<br/>No URL configured] --> UseOriginal
    CheckURL -->|Yes| CallHeadroom[Call Headroom API]
    
    CallHeadroom -->|Success| UseCompressed[Use Compressed Payload]
    CallHeadroom -->|Timeout| WarnTimeout[Log Warning<br/>Timeout occurred] --> UseOriginal
    CallHeadroom -->|Error| WarnError[Log Warning<br/>Compression failed] --> UseOriginal
    
    UseOriginal --> SendUpstream[Send to Upstream]
    UseCompressed --> SendUpstream
    
    SendUpstream --> End[Return Response]
    
    style UseOriginal fill:#87ceeb
    style UseCompressed fill:#90ee90
    style WarnNoURL fill:#ffcccb
    style WarnTimeout fill:#ffcccb
    style WarnError fill:#ffcccb
```

## State Management

```mermaid
stateDiagram-v2
    [*] --> Disabled: Initial State
    
    Disabled --> Enabled: Admin toggles ON
    Enabled --> Disabled: Admin toggles OFF
    
    state Enabled {
        [*] --> CheckingURL
        CheckingURL --> NoURL: URL not configured
        CheckingURL --> Ready: URL configured
        
        NoURL --> Fallback
        Ready --> Compressing: Request arrives
        
        Compressing --> Success: HTTP 200
        Compressing --> Timeout: Timeout exceeded
        Compressing --> Error: HTTP error
        
        Timeout --> Fallback
        Error --> Fallback
        
        Success --> [*]
        Fallback --> [*]
    }
    
    Disabled --> [*]: All requests bypass
```

## Sequence Diagram

```mermaid
sequenceDiagram
    participant C as Client
    participant G as Gateway
    participant CH as Config Handler
    participant CP as Compressor
    participant H as Headroom Service
    participant U as Upstream Provider
    
    C->>G: POST /v1/chat/completions
    G->>CH: getProxyConfig()
    CH-->>G: { headroom: { enabled: true, url: "..." } }
    
    alt headroom.enabled == true
        G->>CP: compressPayload(body)
        CP->>H: POST /v1/compress
        
        alt Success
            H-->>CP: Compressed payload
            CP-->>G: Compressed body
            G->>U: Execute with compressed
        else Timeout/Error
            H--xCP: Error/Timeout
            CP-->>G: Original body (fallback)
            Note over CP,G: ⚠️ Warning logged
            G->>U: Execute with original
        end
    else headroom.enabled == false
        G->>U: Execute with original
    end
    
    U-->>G: Response
    G-->>C: Response
```
