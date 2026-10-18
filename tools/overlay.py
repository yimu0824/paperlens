import json, sys, fitz
pdf = sys.argv[1]; js = sys.argv[2]; pages = [int(x) for x in sys.argv[3].split(',')]
d = json.load(open(js, encoding='utf8'))
doc = fitz.open(pdf)
COL = {'para': (0.1,0.4,1), 'heading': (0.85,0.1,0.1), 'list': (0.95,0.55,0.05),
       'caption': (0.05,0.6,0.2), 'formula': (0.6,0.2,0.8), 'meta': (0.6,0.6,0.6)}
for p in pages:
    page = doc[p-1]; W, H = page.rect.width, page.rect.height
    pm = page.get_pixmap(dpi=120); img = pm
    # draw on a copy
    for para in d['paragraphs']:
        if para['page'] != p-1: continue
        c = COL.get(para['type'], (0,0,0))
        r = fitz.Rect(para['x'], H-para['y']-para['h'], para['x']+para['w'], H-para['y'])
        page.draw_rect(r, color=c, width=0.7)
    for reg in d['layout']['pages'][p-1]['regions']:
        r = fitz.Rect(reg['x'], H-reg['y']-reg['h'], reg['x']+reg['w'], H-reg['y'])
        page.draw_rect(r, color=(1,0,0), width=1.6)
    for col in d['layout']['pages'][p-1]['cols']:
        page.draw_line(fitz.Point(col['x0'], 0), fitz.Point(col['x0'], H), color=(0,0.8,0.8), width=1)
    pm = page.get_pixmap(dpi=120)
    pm.save(f'E:/WorkBuddyData/notebooklm/dbg_p{p}.png')
    print('saved', p)
