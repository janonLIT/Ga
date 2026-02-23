export default {
  async fetch(request, env, ctx) {
    // 1. CORS Setup (Allows your frontend to talk to this proxy)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*', // Change '*' to your website URL later for better security
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

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
      // Safely parse incoming request
      let body;
      try {
        body = await request.json();
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Invalid JSON body sent to proxy.' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const isStream = body.stream === true;
      const nimBaseUrl = env.NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1';

      // 2. Call NVIDIA NIM
      const nvidiaResponse = await fetch(`${nimBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.NVIDIA_API_KEY}`,
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!nvidiaResponse.ok) {
        const errorText = await nvidiaResponse.text();
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

      // 3. Ultra-Stable Streaming Logic
      const SHOW_REASONING = env.SHOW_REASONING !== 'false';
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const reader = nvidiaResponse.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();

      // Run stream processing in background without blocking the response
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
                    await writer.write(encoder.encode(line + '\n\n'));
                  }
                }
              }
              await writer.write(encoder.encode('data: [DONE]\n\n'));
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Prevents stream crashing from cut-off JSON

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
                  // Safe fail: if JSON is bad, just pass the raw string so it doesn't break
                  await writer.write(encoder.encode(line + '\n\n'));
                }
              } else {
                await writer.write(encoder.encode(line + '\n\n'));
              }
            }
          }
        } catch (error) {
          try {
             await writer.write(encoder.encode(`data: {"error": "Stream interrupted"}\n\n`));
             await writer.write(encoder.encode('data: [DONE]\n\n'));
          } catch (e) {}
        } finally {
          await writer.close();
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
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};