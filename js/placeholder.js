// Draws a fake equirectangular panorama so the game is playable before real
// photos exist. Returns a Promise<blob URL>.

export function placeholderPano(label, seed = 0) {
  const w = 2048;
  const h = 1024;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const hue = (seed * 67 + 10) % 360;

  // Sky
  const sky = g.createLinearGradient(0, 0, 0, h / 2);
  sky.addColorStop(0, `hsl(${hue} 55% 22%)`);
  sky.addColorStop(1, `hsl(${hue} 50% 72%)`);
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h / 2);

  // Ground
  const ground = g.createLinearGradient(0, h / 2, 0, h);
  ground.addColorStop(0, `hsl(${(hue + 40) % 360} 25% 40%)`);
  ground.addColorStop(1, `hsl(${(hue + 40) % 360} 25% 15%)`);
  g.fillStyle = ground;
  g.fillRect(0, h / 2, w, h / 2);

  // Grid: a line every 15° of yaw, and at ±30° / ±60° pitch
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.lineWidth = 2;
  for (let i = 0; i < 24; i++) {
    const x = (i / 24) * w;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  }
  for (const pitch of [-60, -30, 30, 60]) {
    const y = h / 2 - (pitch / 180) * h;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.6)';
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();

  // Labels around the horizon (yaw 0 is the image center)
  g.textAlign = 'center';
  g.fillStyle = '#fff';
  const marks = [['S', 0], ['W', 0.25], ['N', 0.5], ['E', 0.75], ['S', 1]];
  for (const [dir, f] of marks) {
    const x = f * w;
    g.font = 'bold 44px system-ui, sans-serif';
    g.fillText(dir, x, h / 2 + 60);
    g.font = 'bold 56px system-ui, sans-serif';
    g.fillText(label, x, h / 2 - 40);
  }

  return new Promise((resolve) =>
    c.toBlob((blob) => resolve(URL.createObjectURL(blob)), 'image/jpeg', 0.9),
  );
}
