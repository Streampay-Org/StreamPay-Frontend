import os, glob, re
path = 'c:/Users/HP USER/Documents/StreamPay-Frontend/scripts/reconciliation/reconcile.test.ts'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

content = re.sub(r'mockImplementation\(\s*async\s*\(\s*\)\s*=>', r"mockImplementation(async (network, id) =>", content)

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
