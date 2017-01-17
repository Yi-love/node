#include "node.h"

#ifdef _WIN32
#include <VersionHelpers.h>
#include <WinError.h>
/**
 * [wmain description]
 * @param  argc  [description]
 * @param  wargv [description]
 * @return       [description]
 * //宽字符到多字节字符转换函数 使用`CP_UTF8`代码页实现`UTF-8`与`Unicode`之间的转换。
  //目的就是首先通过`WideCharToMultiByte`函数获取每个参数的`size`,
  //然后根据size把宽字节的`wargv[i]`拷贝到`argv[i]`,这也就是
  //源码中，`WideCharToMultiByte`函数每次循环都执行2次的原因。
 */
int wmain(int argc, wchar_t *wargv[]) {
  if (!IsWindows7OrGreater()) {
    fprintf(stderr, "This application is only supported on Windows 7, "
                    "Windows Server 2008 R2, or higher.");
    exit(ERROR_EXE_MACHINE_TYPE_MISMATCH);
  }

  // Convert argv to to UTF8
  char** argv = new char*[argc + 1];
  for (int i = 0; i < argc; i++) {
    // Compute the size of the required buffer
    // 宽字节转多字节 ，获取大小
    DWORD size = WideCharToMultiByte(CP_UTF8,
                                     0,
                                     wargv[i],
                                     -1,
                                     nullptr,
                                     0,
                                     nullptr,
                                     nullptr);
    if (size == 0) {
      // This should never happen.
      fprintf(stderr, "Could not convert arguments to utf8.");
      exit(1);
    }
    // Do the actual conversion
    // 重新根据大小计算数据
    argv[i] = new char[size];
    DWORD result = WideCharToMultiByte(CP_UTF8,
                                       0,
                                       wargv[i],
                                       -1,
                                       argv[i],
                                       size,
                                       nullptr,
                                       nullptr);
    if (result == 0) {
      // This should never happen.
      fprintf(stderr, "Could not convert arguments to utf8.");
      exit(1);
    }
  }
  argv[argc] = nullptr;
  // Now that conversion is done, we can finally start.
  return node::Start(argc, argv);
}
#else
// UNIX
int main(int argc, char *argv[]) {
  // Disable stdio buffering, it interacts poorly with printf()
  // calls elsewhere in the program (e.g., any logging from V8.)
  // 设置为不缓存
  setvbuf(stdout, nullptr, _IONBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  return node::Start(argc, argv);
}
#endif
