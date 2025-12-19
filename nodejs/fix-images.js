#!/usr/bin/env node

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

/**
 * 定义文件签名（Magic Numbers）
 */
const SIGNATURES = {
    PNG: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    GIF89a: Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), // GIF89a
    GIF87a: Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]), // GIF87a
    JPG: Buffer.from([0xFF, 0xD8, 0xFF]),
    BMP: Buffer.from([0x42, 0x4D]), // BM
    WEBP_RIFF: Buffer.from([0x52, 0x49, 0x46, 0x46]), // RIFF
    WEBP_WEBP: Buffer.from([0x57, 0x45, 0x42, 0x50]), // WEBP (offset 8)
};

/**
 * 辅助：比较 Buffer 是否相等
 */
function bufferStartsWith(buffer, prefix) {
    if (buffer.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
        if (buffer[i] !== prefix[i]) return false;
    }
    return true;
}

/**
 * 高精度检测文件格式
 */
async function detectImageFormat(filePath) {
    let fileHandle = null;
    try {
        fileHandle = await fsPromises.open(filePath, 'r');
        // 读取前 32 个字节 (足以覆盖大部分文件头和检测 APNG 的 acTL 块)
        const buffer = Buffer.alloc(32);
        const { bytesRead } = await fileHandle.read(buffer, 0, 32, 0);

        if (bytesRead < 8) return null;

        // 1. 严格检测 PNG
        if (bufferStartsWith(buffer, SIGNATURES.PNG)) {
            // 进阶：虽然都是png，但我们可以简单看看有没有 acTL 块 (APNG特征)
            // 这不影响后缀，但可以在日志里区分
            const isApng = buffer.includes('acTL', 8, 'ascii');
            return { ext: 'png', type: isApng ? 'APNG (动图)' : 'PNG' };
        }

        // 2. 严格检测 GIF (必须包含版本号 89a 或 87a)
        if (bufferStartsWith(buffer, SIGNATURES.GIF89a) || bufferStartsWith(buffer, SIGNATURES.GIF87a)) {
            return { ext: 'gif', type: 'GIF' };
        }

        // 3. 检测 JPEG
        if (bufferStartsWith(buffer, SIGNATURES.JPG)) {
            return { ext: 'jpg', type: 'JPEG' };
        }

        // 4. 检测 WebP (RIFF + size + WEBP)
        if (bufferStartsWith(buffer, SIGNATURES.WEBP_RIFF) && 
            buffer.slice(8, 12).equals(SIGNATURES.WEBP_WEBP)) {
            return { ext: 'webp', type: 'WebP' };
        }

        // 5. 检测 BMP
        if (bufferStartsWith(buffer, SIGNATURES.BMP)) {
            return { ext: 'bmp', type: 'BMP' };
        }

        // 未知格式，返回文件头Hex供调试
        return { 
            ext: null, 
            debugHex: buffer.slice(0, 8).toString('hex').toUpperCase() 
        };

    } catch (error) {
        return null;
    } finally {
        if (fileHandle) await fileHandle.close();
    }
}

async function processDirectory(dirPath) {
    const stats = { processed: 0, renamed: 0, errors: 0, skipped: 0 };
    
    try {
        const files = await fsPromises.readdir(dirPath);
        const batchSize = 20;

        for (let i = 0; i < files.length; i += batchSize) {
            const batch = files.slice(i, i + batchSize);
            
            await Promise.all(batch.map(async (file) => {
                if (file.startsWith('.')) return; // 跳过系统隐藏文件

                const filePath = path.join(dirPath, file);
                
                try {
                    const fileStat = await fsPromises.stat(filePath);
                    if (!fileStat.isFile()) return;
                    
                    const result = await detectImageFormat(filePath);
                    
                    // 无法识别格式的处理
                    if (!result || !result.ext) {
                        if (result && result.debugHex) {
                            // 只有当文件看起来像乱码时才打印，避免刷屏
                            // console.log(`[跳过] 未知格式: ${file} (Hex: ${result.debugHex})`);
                        }
                        stats.skipped++;
                        return;
                    }

                    stats.processed++;
                    const correctExt = result.ext;
                    
                    // 获取当前后缀（不带点）
                    const currentExt = path.extname(file).replace('.', '').toLowerCase();
                    
                    // 判断是否需要重命名
                    // 允许 jpeg = jpg
                    const isCorrect = (currentExt === correctExt) || 
                                      (currentExt === 'jpeg' && correctExt === 'jpg');

                    if (!isCorrect) {
                        // 保留原始文件名，只修改后缀
                        const nameWithoutExt = path.parse(file).name;
                        const newName = `${nameWithoutExt}.${correctExt}`;
                        const newPath = path.join(dirPath, newName);
                        
                        if (file !== newName) {
                            // 检查目标是否存在
                            try {
                                await fsPromises.access(newPath);
                                // console.warn(`[跳过] 目标已存在: ${newName}`);
                            } catch (e) {
                                await fsPromises.rename(filePath, newPath);
                                console.log(`[修复] ${file} -> .${correctExt} \t[${result.type}]`);
                                stats.renamed++;
                            }
                        }
                    }
                } catch (error) {
                    console.error(`处理出错: ${file}`, error.message);
                    stats.errors++;
                }
            }));
        }
    } catch (error) {
        console.error(`目录无效: ${dirPath}`, error.message);
    }
    
    return stats;
}

async function main() {
    const args = process.argv.slice(2);
    const targetDir = args[0] || './Ori'; // 默认当前目录下的 Ori 文件夹
    
    console.log(`正在扫描目录: ${targetDir}`);
    console.log(`启用严格模式：精确区分 PNG/GIF/WebP ...\n`);
    
    const startTime = Date.now();
    const stats = await processDirectory(targetDir);
    const endTime = Date.now();
    
    console.log('\n=== 处理完成 ===');
    console.log(`有效图片: ${stats.processed}`);
    console.log(`修复后缀: ${stats.renamed}`);
    console.log(`跳过文件: ${stats.skipped} (非图片或未知格式)`);
    console.log(`耗时: ${(endTime - startTime)}ms`);
}

if (require.main === module) {
    main();
                                        }
