const fs = require('fs');
const p = 'C:/projetos/PRODUCAO/frontend-educa/src/features/agente-educa/AgentePlanos.jsx';
let content = fs.readFileSync(p, 'utf8');

const target = `              style={{
                  ? "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)"
                  : "linear-gradient(145deg, rgba(30, 41, 59, 0.8), rgba(15, 23, 42, 0.8))",
                  ? "0 8px 20px -4px rgba(124, 58, 237, 0.5), inset 0 1px 1px rgba(255, 255, 255, 0.3)" 
                  : "0 4px 6px -1px rgba(0, 0, 0, 0.2), inset 0 1px 1px rgba(255, 255, 255, 0.05)",
              }}`;
content = content.replace(target, '');
fs.writeFileSync(p, content);

const p2 = 'C:/projetos/PRODUCAO/frontend-educa/src/features/agente-educa/AgenteNotas.jsx';
let content2 = fs.readFileSync(p2, 'utf8');
const target2 = `              style={{
                  ? "linear-gradient(135deg, #10b981 0%, #0891b2 100%)"
                  : "linear-gradient(145deg, rgba(30, 41, 59, 0.8), rgba(15, 23, 42, 0.8))",
                  ? "0 8px 20px -4px rgba(16, 185, 129, 0.5), inset 0 1px 1px rgba(255, 255, 255, 0.3)" 
                  : "0 4px 6px -1px rgba(0, 0, 0, 0.2), inset 0 1px 1px rgba(255, 255, 255, 0.05)",
              }}`;
content2 = content2.replace(target2, '');
fs.writeFileSync(p2, content2);

console.log('done');
