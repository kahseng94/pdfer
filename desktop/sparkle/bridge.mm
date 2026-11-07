// Sparkle's user-driver API runs on AppKit's main thread. Only a fixed set of
// commands crosses Node-API; URLs, signatures and installation are owned by Sparkle.
#import <AppKit/AppKit.h>
#import <Sparkle/Sparkle.h>
#include <node_api.h>
#include <string>

static napi_threadsafe_function callback = nullptr;

static void emit(NSDictionary *value) {
    if (callback == nullptr) return;
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    auto *json = new std::string(static_cast<const char *>(data.bytes), data.length);
    if (napi_call_threadsafe_function(callback, json, napi_tsfn_nonblocking) != napi_ok) delete json;
}

@interface PDFSparkleDriver : NSObject <SPUUserDriver, SPUUpdaterDelegate>
@property(nonatomic, strong) SPUUpdater *updater;
@property(nonatomic, copy) NSString *version;
@property(nonatomic, copy) void (^updateReply)(SPUUserUpdateChoice);
@property(nonatomic, copy) void (^installReply)(SPUUserUpdateChoice);
@property(nonatomic, copy) void (^cancellation)(void);
@property(nonatomic, strong) NSDictionary *pendingFailure;
@property(nonatomic) uint64_t expected;
@property(nonatomic) uint64_t received;
@property(nonatomic) BOOL stopping;
@property(nonatomic) BOOL pendingCheck;
- (void)cancel;
@end

@implementation PDFSparkleDriver
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
    reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO automaticUpdateDownloading:@NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {
    self.cancellation = cancellation;
    emit(@{@"event": @"checking"});
}
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
    self.cancellation = nil;
    if (item.informationOnlyUpdate) {
        reply(SPUUserUpdateChoiceDismiss);
        emit(@{@"event": @"error", @"message": @"This release requires a manual download."});
        return;
    }
    self.version = item.displayVersionString;
    if (state.stage == SPUUserUpdateStageInstalling) {
        self.installReply = reply;
        emit(@{@"event": @"downloaded", @"version": self.version});
    } else {
        self.updateReply = reply;
        emit(@{@"event": @"available", @"version": self.version});
    }
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)data {}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {}
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
    emit(@{@"event": @"not-available"});
    acknowledgement();
}
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
    // Acknowledging the error starts teardown of the failed installation. Don't
    // expose Retry until that cycle has finished, especially on slower machines.
    if (!self.stopping) self.pendingFailure = @{@"event": @"error", @"message": error.localizedDescription ?: @"Update failed."};
    acknowledgement();
}
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation {
    self.cancellation = cancellation;
    self.expected = 0;
    self.received = 0;
    emit(@{@"event": @"progress", @"percent": @0});
}
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)length { self.expected = length; }
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {
    self.received += length;
    double percent = self.expected == 0 ? 0 : MIN(100.0, 100.0 * self.received / self.expected);
    emit(@{@"event": @"progress", @"percent": @(percent)});
}
- (void)showDownloadDidStartExtractingUpdate {
    // Verification-before-extraction is required by the host's Info.plist.
    self.cancellation = nil;
    emit(@{@"event": @"progress", @"percent": @100});
}
- (void)showExtractionReceivedProgress:(double)progress {}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
    self.installReply = reply;
    if (self.stopping) { [self cancel]; return; }
    emit(@{@"event": @"downloaded", @"version": self.version ?: @""});
}
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated retryTerminatingApplication:(void (^)(void))retry {
    emit(@{@"event": @"installing"});
}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))acknowledgement { acknowledgement(); }
- (void)dismissUpdateInstallation {
    self.updateReply = nil;
    self.installReply = nil;
    self.cancellation = nil;
}
- (void)updater:(SPUUpdater *)updater didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check error:(NSError *)error {
    if (self.stopping) emit(@{@"event": @"stopped"});
    else {
        NSDictionary *failure = self.pendingFailure;
        self.pendingFailure = nil;
        BOOL checkAgain = self.pendingCheck;
        self.pendingCheck = NO;
        // Let Sparkle finish its own state reset after this delegate returns.
        dispatch_async(dispatch_get_main_queue(), ^{
            if (failure) emit(failure);
            if (checkAgain && !self.stopping) [self.updater checkForUpdates];
        });
    }
}
- (void)cancel {
    self.stopping = YES;
    if (self.installReply) {
        void (^reply)(SPUUserUpdateChoice) = self.installReply;
        self.installReply = nil;
        // Skip cancels a staged installation; Dismiss would install on app exit.
        reply(SPUUserUpdateChoiceSkip);
    } else if (self.updateReply) {
        void (^reply)(SPUUserUpdateChoice) = self.updateReply;
        self.updateReply = nil;
        reply(SPUUserUpdateChoiceDismiss);
    } else if (self.cancellation) {
        void (^cancel)(void) = self.cancellation;
        self.cancellation = nil;
        cancel();
    } else if (!self.updater.sessionInProgress) {
        emit(@{@"event": @"stopped"});
    }
    // During extraction, showReadyToInstallAndRelaunch will cancel before quitting.
}
@end

static PDFSparkleDriver *driver;

static void callJavaScript(napi_env env, napi_value function, void *, void *raw) {
    auto *json = static_cast<std::string *>(raw);
    if (env != nullptr) {
        napi_value argument, global;
        napi_create_string_utf8(env, json->data(), json->size(), &argument);
        napi_get_undefined(env, &global);
        napi_call_function(env, global, function, 1, &argument, nullptr);
    }
    delete json;
}
static void cleanup(void *) {
    if (callback != nullptr) {
        napi_release_threadsafe_function(callback, napi_tsfn_abort);
        callback = nullptr;
    }
}
static napi_value start(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1], resourceName, result;
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    napi_valuetype type;
    if (argc != 1 || napi_typeof(env, args[0], &type) != napi_ok || type != napi_function || driver != nil) {
        napi_throw_error(env, nullptr, "Sparkle requires one callback and can only be initialized once.");
        return nullptr;
    }
    napi_create_string_utf8(env, "pdfer Sparkle events", NAPI_AUTO_LENGTH, &resourceName);
    napi_create_threadsafe_function(env, args[0], nullptr, resourceName, 0, 1, nullptr, nullptr, nullptr, callJavaScript, &callback);
    napi_unref_threadsafe_function(env, callback);
    napi_add_env_cleanup_hook(env, cleanup, nullptr);
    dispatch_async(dispatch_get_main_queue(), ^{
        driver = [PDFSparkleDriver new];
        NSBundle *bundle = [NSBundle mainBundle];
        driver.updater = [[SPUUpdater alloc] initWithHostBundle:bundle applicationBundle:bundle userDriver:driver delegate:driver];
        NSError *error = nil;
        if (![driver.updater startUpdater:&error]) emit(@{@"event": @"error", @"message": error.localizedDescription ?: @"Could not start Sparkle."});
        else emit(@{@"event": @"ready"});
    });
    napi_get_undefined(env, &result);
    return result;
}
static napi_value check(napi_env env, napi_callback_info info) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (driver == nil || driver.stopping) return;
        if (!driver.updater.sessionInProgress) [driver.updater checkForUpdates];
        else driver.pendingCheck = YES;
    });
    napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value download(napi_env env, napi_callback_info info) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (driver.updateReply) {
            void (^reply)(SPUUserUpdateChoice) = driver.updateReply;
            driver.updateReply = nil;
            reply(SPUUserUpdateChoiceInstall);
        } else emit(@{@"event": @"error", @"message": @"Check for updates again before downloading."});
    });
    napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value install(napi_env env, napi_callback_info info) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (driver.installReply) {
            void (^reply)(SPUUserUpdateChoice) = driver.installReply;
            driver.installReply = nil;
            reply(SPUUserUpdateChoiceInstall);
        } else emit(@{@"event": @"error", @"message": @"The update is not ready to install."});
    });
    napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value stop(napi_env env, napi_callback_info info) {
    dispatch_async(dispatch_get_main_queue(), ^{ if (driver) [driver cancel]; else emit(@{@"event": @"stopped"}); });
    napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
    napi_property_descriptor methods[] = {
        {"start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"check", nullptr, check, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"download", nullptr, download, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"install", nullptr, install, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stop", nullptr, stop, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
    return exports;
}
NAPI_MODULE(pdfer_sparkle, initialize)
