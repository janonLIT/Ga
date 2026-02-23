export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*', 
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization', 
    };

    // 1. DIAGNOSTIC FEATURE: Health Check Endpoint
    // If you visit the Worker URL in your browser, it will now tell you if it's alive!
    if (request.method === 'GET') {
      return new Response(JSON.stringify({ 
        status: "success", 
        message: "NIM BYOK Proxy is online and running perfectly.",
        timestamp: new Date().toISOString()
      }), { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { 
        status: 405, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    try {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) {
        console.error("Diagnostic: Request rejected - Missing Authorization header.");
        return new Response(JSON.stringify({ error: 'Missing API Key.' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      let body;
      try {
        body = await request.json();
      } catch (err) {
        console.error("Diagnostic: Failed to parse incoming JSON from chat app.", err);
        return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Log the model being requested for debugging
      console.log(`Diagnostic: Forwarding request to NVIDIA for model: ${body.model || 'default'}`);

      const isStream = body.stream === true;
      const nimBaseUrl = env.NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1';

      const nvidiaResponse = await fetch(`${nimBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!nvidiaResponse.ok) {
        const errorText = await nvidiaResponse.text();
        console.error(`Diagnostic: NVIDIA API Error ${nvidiaResponse.status}:`, errorText);
        return new Response(errorText, { 
          status: nvidiaResponse.status, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }

      if (!isStream) {
        return new Response(JSON.stringify(await nvidiaResponse.json()), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // --- PDF STREAMING LOGIC WITH FULL DIAGNOSTICS ---
      const SHOW_REASONING = env.SHOW_REASONING !== 'false';
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const reader = nvidiaResponse.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();

      ctx.waitUntil((async () => {
        let buffer = '';
        let reasoningStarted = false;

        try {
          while (true) {
            const { done, value } = await reader.read();
            
            if (done) {
              if (buffer.trim().length > 0) {
                const remainingLines = buffer.split('\n');
                for (const line of remainingLines) {
                  if (line.trim().startsWith('data: ') && !line.includes('[DONE]')) {
                    try {
                      await writer.write(encoder.encode(line + '\n\n'));
                    } catch (e) {
                      console.error('Diagnostic: Error writing remaining buffer:', e);
                    }
                  }
                }
              }
              await writer.write(encoder.encode('data: [DONE]\n\n'));
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; 

            for (const line of lines) {
              if (!line.trim()) continue;

              if (line.startsWith('data: ')) {
                if (line.includes('[DONE]')) {
                  await writer.write(encoder.encode(line + '\n\n'));
                  continue;
                }

                try {
                  const jsonStr = line.slice(6);
                  const data = JSON.parse(jsonStr);

                  if (data.choices?.[0]?.delta) {
                    const reasoning = data.choices[0].delta.reasoning_content;
                    const content = data.choices[0].delta.content;

                    if (SHOW_REASONING) {
                      let combinedContent = '';
                      if (reasoning && !reasoningStarted) {
                        combinedContent = '<think>\n' + reasoning;
                        reasoningStarted = true;
                      } else if (reasoning) {
                        combinedContent = reasoning;
                      }

                      if (content && reasoningStarted) {
                        combinedContent += '\n</think>\n\n' + content;
                        reasoningStarted = false;
                      } else if (content) {
                        combinedContent += content;
                      }

                      if (combinedContent) {
                        data.choices[0].delta.content = combinedContent;
                      } else if (!content) {
                        data.choices[0].delta.content = ''; 
                      }
                      delete data.choices[0].delta.reasoning_content;
                    } else {
                      data.choices[0].delta.content = content || '';
                      delete data.choices[0].delta.reasoning_content;
                    }
                  }

                  await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                } catch (e) {
                  // PDF Diagnostic: Log JSON failures but keep stream alive
                  console.error('Diagnostic: JSON parse error on stream chunk:', e);
                  await writer.write(encoder.encode(line + '\n\n'));
                }
              } else {
                await writer.write(encoder.encode(line + '\n\n'));
              }
            }
          }
        } catch (error) {
          // PDF Diagnostic: Exact error forwarding
          console.error('Diagnostic: Streaming error intercepted:', error);
          try {
             // Send the actual error message to the frontend so the app knows what failed
             await writer.write(encoder.encode(`data: {"error": "${error.message}"}\n\n`));
             await writer.write(encoder.encode('data: [DONE]\n\n'));
          } catch (e) {
             console.error('Diagnostic: Error writing error message to stream:', e);
          }
        } finally {
          // PDF Diagnostic: Safely close the writer and catch closure errors
          try {
            await writer.close();
            console.log("Diagnostic: Stream closed successfully.");
          } catch (e) {
            console.error('Diagnostic: Error closing writer:', e);
          }
        }
      })());

      return new Response(readable, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });

    } catch (error) {
      console.error("Diagnostic: Fatal Server Error:", error);
      return new Response(JSON.stringify({ error: error.message || 'Internal Server Error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};