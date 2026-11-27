package cn.codeemo.fizz.runtime;

import android.system.Os;
import java.io.EOFException;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.LongConsumer;
import java.util.zip.GZIPInputStream;

/** 读取构建器生成的 GNU tar + gzip（.tgz）；延后创建符号链接，解包期间绝不沿链接写出目标目录。 */
final class RuntimeArchive {
    private static final class Link {
        final Path path;
        final String target;
        Link(Path path, String target) { this.path = path; this.target = target; }
    }

    static void extract(InputStream raw, File directory, BooleanSupplier cancelled, LongConsumer progress) throws Exception {
        directory.mkdirs();
        Path root = directory.toPath().toAbsolutePath().normalize();
        List<Link> links = new ArrayList<>();
        byte[] header = new byte[512];
        byte[] buffer = new byte[65536];
        String longName = null;
        String longLink = null;
        long total = 0;
        try (InputStream input = new GZIPInputStream(raw, 65536)) {
            while (true) {
                if (cancelled.getAsBoolean()) throw new InterruptedException("安装已取消");
                readFully(input, header, 512);
                boolean empty = true;
                for (byte value : header) if (value != 0) { empty = false; break; }
                if (empty) break;
                long checksum = octal(header, 148, 8);
                long actual = 0;
                for (int i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i] & 255;
                if (checksum != actual) throw new IOException("运行环境 tar 校验失败");
                long size = octal(header, 124, 12);
                int type = header[156];
                if (type == 'L' || type == 'K') {
                    if (size > 65536) throw new IOException("运行环境文件名过长");
                    byte[] value = new byte[(int) size];
                    readFully(input, value, value.length);
                    if (type == 'L') longName = text(value, 0, value.length);
                    else longLink = text(value, 0, value.length);
                } else {
                    String name = longName != null ? longName : text(header, 0, 100);
                    String target = longLink != null ? longLink : text(header, 157, 100);
                    longName = null;
                    longLink = null;
                    Path output = root.resolve(name).normalize();
                    if (!output.startsWith(root)) throw new IOException("运行环境包含越界路径");
                    File file = output.toFile();
                    if (type == '5') {
                        if (!file.isDirectory() && !file.mkdirs()) throw new IOException("无法创建目录：" + name);
                    } else if (type == '2') {
                        if (output.equals(root)) throw new IOException("运行环境根目录不能是链接");
                        links.add(new Link(output, target));
                    } else if (type == 0 || type == '0') {
                        File parent = file.getParentFile();
                        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("无法创建目录：" + name);
                        try (FileOutputStream out = new FileOutputStream(file)) {
                            long remaining = size;
                            while (remaining > 0) {
                                if (cancelled.getAsBoolean()) throw new InterruptedException("安装已取消");
                                int count = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                                if (count < 0) throw new EOFException("运行环境文件不完整");
                                out.write(buffer, 0, count);
                                remaining -= count;
                            }
                        }
                        Os.chmod(file.getPath(), (int) octal(header, 100, 8) & 0777);
                    } else {
                        throw new IOException("不支持的运行环境 tar 条目：" + type);
                    }
                    if (type != 0 && type != '0') skipFully(input, size, buffer);
                }
                skipFully(input, (512 - size % 512) % 512, buffer);
                total += 512 + ((size + 511) / 512) * 512;
                progress.accept(total);
            }
        }
        for (Link link : links) {
            if (cancelled.getAsBoolean()) throw new InterruptedException("安装已取消");
            // 先前创建的链接不能变成后续链接的父目录。
            Path parent = link.path.getParent();
            while (!parent.equals(root)) {
                if (Files.isSymbolicLink(parent)) throw new IOException("运行环境包含链接父目录");
                parent = parent.getParent();
            }
            Files.createDirectories(link.path.getParent());
            if (Files.exists(link.path, LinkOption.NOFOLLOW_LINKS)) throw new IOException("运行环境包含重复链接");
            Os.symlink(link.target, link.path.toString());
        }
    }

    static void deleteTree(File file) throws IOException {
        // 不跟随 rootfs 中的绝对符号链接（例如 /etc/mtab -> /proc/mounts）。
        if (Files.isDirectory(file.toPath(), LinkOption.NOFOLLOW_LINKS)) {
            File[] children = file.listFiles();
            if (children == null) throw new IOException("无法读取目录：" + file);
            for (File child : children) deleteTree(child);
        }
        Files.deleteIfExists(file.toPath());
    }

    private static String text(byte[] bytes, int offset, int length) {
        int end = offset;
        while (end < offset + length && bytes[end] != 0) end++;
        return new String(bytes, offset, end - offset, StandardCharsets.UTF_8);
    }

    private static long octal(byte[] bytes, int offset, int length) throws IOException {
        String value = text(bytes, offset, length).trim();
        try { return value.isEmpty() ? 0 : Long.parseLong(value, 8); }
        catch (NumberFormatException error) { throw new IOException("运行环境 tar 数值无效", error); }
    }

    private static void readFully(InputStream input, byte[] buffer, int length) throws IOException {
        int offset = 0;
        while (offset < length) {
            int count = input.read(buffer, offset, length - offset);
            if (count < 0) throw new EOFException("运行环境包不完整");
            offset += count;
        }
    }

    private static void skipFully(InputStream input, long length, byte[] buffer) throws IOException {
        while (length > 0) {
            int count = input.read(buffer, 0, (int) Math.min(length, buffer.length));
            if (count < 0) throw new EOFException("运行环境包不完整");
            length -= count;
        }
    }
}
