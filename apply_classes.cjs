const fs = require('fs');

const updateClasses = (path, prefix) => {
  let content = fs.readFileSync(path, 'utf8');

  // Replace block 1 (Status)
  const regex1 = /onClick=\{\(\) => setFiltro\(f\.key\)\}/g;
  content = content.replace(regex1, 'onClick={() => setFiltro(f.key)}\n                className={`premium-pill-btn ' + prefix + '${filtro === f.key ? "active" : ""}`}');

  // Replace block 2 (Bimestre)
  const regex2 = /onClick=\{\(\) => setFiltroBimestre\(b\.key\)\}/g;
  content = content.replace(regex2, 'onClick={() => setFiltroBimestre(b.key)}\n                className={`premium-pill-btn premium-pill-sm ' + prefix + '${ativo ? "active" : ""}`}');

  // Replace badge style 1
  const badge1 = /<span style=\{\{\n[\s\S]*?\}\}>\{f\.count\}<\/span>/g;
  content = content.replace(badge1, '<span className="badge">{f.count}</span>');

  // Replace badge style 2
  const badge2 = /<span style=\{\{\n[\s\S]*?\}\}>\{b\.total\}<\/span>/g;
  content = content.replace(badge2, '<span className="badge" style={ativo ? {} : { opacity: b.total === 0 ? 0.3 : 1 }}>{b.total}</span>');

  // Remove the little dot in bimestre buttons
  const dot = /<span style=\{\{\n\s*width: 8, height: 8, borderRadius: "50%", flexShrink: 0,[\s\S]*?\}\} \/>/g;
  content = content.replace(dot, '');

  fs.writeFileSync(path, content);
};

updateClasses('C:/projetos/PRODUCAO/frontend-educa/src/features/agente-educa/AgentePlanos.jsx', '');
updateClasses('C:/projetos/PRODUCAO/frontend-educa/src/features/agente-educa/AgenteNotas.jsx', 'premium-pill-btn-green ');

console.log('Classes applied!');
