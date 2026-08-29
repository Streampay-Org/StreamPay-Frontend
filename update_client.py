import os, glob, re

target = 'c:/Users/HP USER/Documents/StreamPay-Frontend'
for root, _, files in os.walk(target):
    for f in files:
        if not f.endswith('.ts') and not f.endswith('.tsx'): continue
        path = os.path.join(root, f)
        if 'node_modules' in path or '.next' in path: continue
        with open(path, 'r', encoding='utf-8') as file:
            content = file.read()
        
        orig_content = content
        
        if f == 'onChainClient.ts' and 'lib' in root:
            content = content.replace('async fetchStream(streamId: string)', 'async fetchStream(network: string, streamId: string)')
            content = content.replace('async cancelStream(streamId: string)', 'async cancelStream(network: string, streamId: string)')
            content = content.replace('async createStream(streamId: string, _payload: unknown)', 'async createStream(network: string, streamId: string, _payload: unknown)')
            # update this.fetchStream calls
            content = content.replace('this.fetchStream(streamId)', 'this.fetchStream(network, streamId)')
        
        else:
            # using regex to properly capture
            content = re.sub(r'onChainClient\.fetchStream\(\s*([^,)]+?)\s*\)', r"onChainClient.fetchStream('testnet', \1)", content)
            content = re.sub(r'onChainClient\.cancelStream\(\s*([^,)]+?)\s*\)', r"onChainClient.cancelStream('testnet', \1)", content)
            content = re.sub(r'onChainClient\.createStream\(\s*([^,]+?)\s*,\s*([^,)]+?)\s*\)', r"onChainClient.createStream('testnet', \1, \2)", content)

            # for mock implementations:
            # jest.spyOn(onChainClient, 'fetchStream').mockImplementation(async (streamId) =>
            # (onChainClient.fetchStream as jest.Mock).mockResolvedValue({
            content = re.sub(r'\(onChainClient\.fetchStream as jest\.Mock\)', r"(onChainClient.fetchStream as jest.Mock)", content) 
            # wait, this doesn't change anything, just noting it.
            
            # mockImplementation(async (id) =>
            content = re.sub(r'mockImplementation\(\s*async\s*\(\s*id\s*\)\s*=>', r"mockImplementation(async (network, id) =>", content)
            content = re.sub(r'mockImplementation\(\s*async\s*\(\s*streamId\s*\)\s*=>', r"mockImplementation(async (network, streamId) =>", content)

            # in chaos tests: mockImplementation(impl as any) -> this might be ok.
            
        if content != orig_content:
            with open(path, 'w', encoding='utf-8') as file:
                file.write(content)
            print(f'Updated {path}')
