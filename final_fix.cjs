const fs = require('fs');

// Add CSS to index.css
const cssPath = 'C:/projetos/PRODUCAO/frontend-educa/src/index.css';
let css = fs.readFileSync(cssPath, 'utf8');
if (!css.includes('.premium-pill-btn')) {
  css += `
/* --- Botões Premium Agente Educa --- */
.premium-pill-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  border-radius: 14px;
  font-weight: 700;
  font-size: 0.82rem;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: linear-gradient(145deg, rgba(30, 41, 59, 0.8), rgba(15, 23, 42, 0.8));
  color: #cbd5e1;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2), inset 0 1px 1px rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(10px);
}
.premium-pill-btn:hover {
  background: linear-gradient(145deg, rgba(40, 51, 71, 0.9), rgba(20, 28, 50, 0.9));
  transform: translateY(-1px);
  border-color: rgba(255, 255, 255, 0.15);
  box-shadow: 0 6px 12px -2px rgba(0, 0, 0, 0.3), inset 0 1px 1px rgba(255, 255, 255, 0.1);
}
.premium-pill-btn:active {
  transform: translateY(1px);
}
.premium-pill-btn.active {
  border: 1px solid rgba(139, 92, 246, 0.7);
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
  color: #ffffff;
  box-shadow: 0 8px 20px -4px rgba(124, 58, 237, 0.6), inset 0 1px 1px rgba(255, 255, 255, 0.4);
  transform: translateY(-1px);
}
.premium-pill-btn.active:hover {
  box-shadow: 0 10px 25px -4px rgba(124, 58, 237, 0.8), inset 0 1px 1px rgba(255, 255, 255, 0.5);
  filter: brightness(1.1);
}
.premium-pill-btn .badge {
  background: rgba(15, 23, 42, 0.6);
  color: #94a3b8;
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  padding: 2px 8px;
  font-size: 0.75rem;
  font-weight: 800;
  box-shadow: inset 0 1px 1px rgba(0,0,0,0.2);
  transition: all 0.3s ease;
}
.premium-pill-btn.active .badge {
  background: rgba(255, 255, 255, 0.25);
  color: #ffffff;
  border: none;
  box-shadow: inset 0 1px 1px rgba(0,0,0,0.1);
}
.premium-pill-sm {
  padding: 8px 16px;
  font-size: 0.76rem;
  border-radius: 12px;
}
.premium-pill-btn-green.active {
  border: 1px solid rgba(16, 185, 129, 0.7);
  background: linear-gradient(135deg, #10b981 0%, #0891b2 100%);
  color: #ffffff;
  box-shadow: 0 8px 20px -4px rgba(16, 185, 129, 0.6), inset 0 1px 1px rgba(255, 255, 255, 0.4);
  transform: translateY(-1px);
}
.premium-pill-btn-green.active:hover {
  box-shadow: 0 10px 25px -4px rgba(16, 185, 129, 0.8), inset 0 1px 1px rgba(255, 255, 255, 0.5);
  filter: brightness(1.1);
}
`;
  fs.writeFileSync(cssPath, css);
}

const fixFile = (path, isGreen) => {
  let content = fs.readFileSync(path, 'utf8');

  // Fix button 1 (Status)
  const regex1 = /onClick=\{\(\) => setFiltro\(f\.key\)\}[\s\S]*?\}\s*>\s*\{f\.label\}\s*<span style=\{\{[\s\S]*?\}\}>\{f\.count\}<\/span>\s*<\/button>/;
  
  const cls1 = isGreen ? "premium-pill-btn premium-pill-btn-green ${filtro === f.key ? 'active' : ''}" : "premium-pill-btn ${filtro === f.key ? 'active' : ''}";

  content = content.replace(regex1, `onClick={() => setFiltro(f.key)}
                className={\`${cls1}\`}
              >
                {f.label}
                <span className="badge">{f.count}</span>
              </button>`);

  // Fix button 2 (Bimestre)
  const regex2 = /onClick=\{\(\) => setFiltroBimestre\(b\.key\)\}[\s\S]*?\}\s*>\s*(<span style=\{\{[\s\S]*?\}\} \/>\s*)?\{b\.short\}\s*<span style=\{\{[\s\S]*?\}\}>\{b\.total\}<\/span>\s*<\/button>/;
  
  const cls2 = isGreen ? "premium-pill-btn premium-pill-btn-green premium-pill-sm ${ativo ? 'active' : ''}" : "premium-pill-btn premium-pill-sm ${ativo ? 'active' : ''}";

  content = content.replace(regex2, `onClick={() => setFiltroBimestre(b.key)}
                  title={b.label}
                  className={\`${cls2}\`}
                >
                  {b.short}
                  <span className="badge" style={ativo ? {} : { opacity: b.total === 0 ? 0.3 : 1 }}>{b.total}</span>
                </button>`);

  fs.writeFileSync(path, content);
};

fixFile('C:/projetos/PRODUCAO/frontend-educa/src/features/agente-educa/AgentePlanos.jsx', false);
fixFile('C:/projetos/PRODUCAO/frontend-educa/src/features/agente-educa/AgenteNotas.jsx', true);

console.log('Done fixing');
