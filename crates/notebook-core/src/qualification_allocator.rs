use std::alloc::{GlobalAlloc, Layout, System};
use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, Ordering};

struct QualificationAllocator;

static FAIL_NEXT_ALLOCATION: AtomicBool = AtomicBool::new(false);

#[global_allocator]
static GLOBAL_ALLOCATOR: QualificationAllocator = QualificationAllocator;

pub(crate) fn fail_next_allocation() {
    FAIL_NEXT_ALLOCATION.store(true, Ordering::SeqCst);
}

fn should_fail() -> bool {
    FAIL_NEXT_ALLOCATION.swap(false, Ordering::SeqCst)
}

unsafe impl GlobalAlloc for QualificationAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if should_fail() {
            null_mut()
        } else {
            unsafe { System.alloc(layout) }
        }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if should_fail() {
            null_mut()
        } else {
            unsafe { System.alloc_zeroed(layout) }
        }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if should_fail() {
            null_mut()
        } else {
            unsafe { System.realloc(pointer, layout, new_size) }
        }
    }
}
