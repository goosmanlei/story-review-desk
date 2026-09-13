#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

// Read the same native type and default application used to open a file. This
// probe does not launch applications or change the user's file associations.
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSMutableArray *results = [NSMutableArray array];
    for (int i = 1; i < argc; i++) {
      NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[i]]];
      id type = nil;
      NSError *error = nil;
      if (![url getResourceValue:&type forKey:NSURLTypeIdentifierKey error:&error]) {
        fprintf(stderr, "%s\n", [[error description] UTF8String]);
        return 1;
      }
      NSURL *app = [[NSWorkspace sharedWorkspace] URLForApplicationToOpenURL:url];
      [results addObject:@{@"type": type ?: [NSNull null],
                           @"application": [app lastPathComponent] ?: [NSNull null]}];
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:results options:0 error:nil];
    fwrite([data bytes], 1, [data length], stdout);
  }
  return 0;
}
